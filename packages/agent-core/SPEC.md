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
which means a crashed executor that comes back later cannot corrupt anything — past its
expiry the lease admits nothing, and once anyone reclaims or fences the Turn its epoch is
stale and its writes are rejected. And a webhook, a cron tick, a slash
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
authority at all. A Lean model checks a documented abstract subset of these semantics;
§14 states its exact boundary and makes no implementation-refinement claim.

### 1.2 What this specifies — and what it leaves to you

Agent Core specifies the platform layer: identity and tenancy, authority, durable
execution, input routing, mediated actions, UI contributions, environments, generated
applications, and the definition plane. It deliberately does **not** specify the agent
loop — model choice, prompting, streaming, tool-call parsing. The loop lives behind the
Turn executor seam (§5.6), so you can drive Runs with the Claude Agent SDK, Pydantic
AI, a bespoke loop, or whatever comes next. Think of Agent Core as everything *around*
the loop.

### 1.3 How to read this document

Sections 1.4, 1.5, and 2–10 are normative; §11–§12 define profiles and sketches; §13–§14 cover
conformance and the formal model. MUST, SHOULD, and MAY are RFC 2119 keywords.
Behavioral contracts appear as abstract TypeScript classes; pure data shapes as
interfaces. Sections marked *(informative)* explain; everything else binds. Short
*why* paragraphs record the reasoning behind the less obvious choices, so the
reasoning itself can be checked and challenged, not just the rules.

### 1.4 Notation and type vocabulary

Identifiers ending in `Id` or `Name` (`PrincipalId`, `SurfaceId`, `BindingName`,
`SlotName`) are opaque, codec-stable identifier types, as are the simple reference
types `ContentRef`, `OperationRef`, `FacetRef`, `RunRef`, `TurnRef`, `ScopeRef`, and
`ActorRef`. The structured record `Ref` types are `PrincipalRef`, `SecretRef` (§3.5),
`ForeignPrincipalRef` (§3.3), and `SubjectRef` — the `PrincipalRef | Team |
ForeignPrincipalRef` union a Membership or Grant names (§3.1, §3.3). `PrincipalRef` is
always tenant-qualified:
`{ tenant: TenantId, id: PrincipalId }`. Every caller, authority initiator or delegate, lease
holder, route initiator, cross-Actor permit, and Membership or Grant subject carries this
canonical form; an unqualified id or mismatched tenant rejects rather than being inferred,
and a record naming both a Scope and a Principal subject rejects a subject qualified by
another Tenant rather than reading the Tenant off wherever the record is stored. This maps to
**C13-AUTH-PRINCIPAL-REF**. Types ending in `Schema`, `Spec`, `Template`, `Mapping`
(declarative field maps over JSON Pointers: `FieldMapping` and `PayloadMapping` are one
shape, defined at §6.2, and `ProvenanceMapping`), `Selector` (predicate sets over
descriptors: `OperationSelector`), `Entry` (`SlotEntry` — a validated contribution instance
plus its contributor), or `Requirement` (`BindingRequirement` — a named capability a facet
needs bound before start) are JSON-Schema-validated records. A type ending in `Policy` is a
declared policy shape, which may be a record or a closed string union (`DedupePolicy`).
`FacetData` is any JSON value: it is what a Surface renders, what an interceptor sees, and
what preparation structurally digests. The unions the prose depends on:

```ts
type Impact          = "observe" | "mutate" | "externalSend" | "execute" | "delegate" | "administer";
type TrustTier       = "owner" | "authenticated" | "external" | "self";      // §6.1
type EnforcementTier = "mediated" | "direct";                                 // §7.2
type IsolationMode   = "bundled" | "provider" | "dynamic";                    // §1.5, §10.2
type CutPoint        = "operation.before" | "operation.after" | "prompt.assemble"
                     | "input.submitted" | "turn.step";                       // §4.4
type InterceptorMode = "rewrite" | "gate";                                    // §4.4
type Contributions   = { readonly [slot: SlotName]: readonly unknown[] };     // validated against
                                                                              // the slot's schema (§4.2)
```

Core value types (fields, not primitives): `Digest` — a collision-resistant content
digest, SHA-256 or stronger; `ContentRef` — resolvable through a ContentStore (§8.2);
`SecretRef` (§3.5); `Revision` — a per-record optimistic-concurrency counter.

A `FacetRef` *identifies* a facet instance; a `Binding` *names* a Grant-backed instance
in one protection domain; a `ResolvedFacet` is the *live capability* returned by
resolution. The canonical serialized `FacetRef` is exactly
`<facet-package-id>:<instance>`, where the first segment is the `FacetPackageId` of §4.1
(`core`, `core.fs`, `acme.deploy`) and not a §3.2 Scope. It contains one and only one `:`
separator, and each segment
matches `^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$`; empty, noncanonical, or additionally
separated forms reject rather than normalize. The order is always the same: identify,
then name, then resolve. This clause maps to **C13-FACET-REF-CANONICAL**.

### 1.5 Protection domains

A **protection domain** is an isolation boundary with exactly one **owning Actor** (§8.1):
the Actor whose process the domain's code runs in, and whose authority that code would
inherit if nothing stopped it. Inside one, calls are plain in-process calls and carry no
security cost. Across one, nothing passes except explicitly delegated capabilities and
asynchronous Events. **Ambient authority** is anything code inside a domain can reach
without presenting a capability: a Binding it was not given, a credential it did not
resolve, a network destination nobody passed it. Platform policy places facet code into a
domain (§9.2, §10.2) using three isolation modes: `bundled` (in-process with the hosting
Actor), `provider` (a separate service behind a capability stub), and `dynamic` (loaded
code in a fresh isolate with zero ambient authority).

Zero ambient authority includes zero ambient egress. A `dynamic` domain MUST start with no
network reach of its own: every destination its code can address arrives as an explicitly
passed Binding, and a domain in which code can open a connection the platform did not give
it is not a `dynamic` domain. The rule is at the substrate and not in a policy layer
because an outbound policy that code can reach around is advice; every `externalSend`
obligation in §11 rests on the difference. This maps to
**C13-PLACEMENT-DYNAMIC-NO-EGRESS**.

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
| L4 Mediation | **Invocation** | PreparedInvocation, Approval, EffectAttempt, Receipt, AuditRecord |

Substrate contracts (L5): **Actor**, **ContentStore**, **RecordCodec**, and the command
protocol dispatcher (§8.5). The definition plane (L6) adds two artifacts: **Package**
and **Blueprint** — eighteen nouns in total.

![The system at a glance](diagrams/overview.svg)

Three paths describe almost every interaction in the system:

```text
ACTIVE       Facet → Invocation(tier) → direct return | mediated PreparedInvocation → [Approval] → [EffectAttempt] → Receipt → Audit → Event
INTERACTION  input → Event → RouteReservation → Subscription target → PreparedInvocation
AUTHORITY    Role allow/deny rules ⇒ Grants → Binding resolver + path epochs → ResolvedFacet
```

Every feature in the assembly sketches of §12 is a composition of these three paths.

---

## 3. Identity and authority (L0)

### 3.1 Principal and Team

A **Principal** is an accountable actor: a human, a service account, a CI bot, or an
independently accountable Agent. Principals authenticate; Scopes own resources.

A **Team** is a named set of Principals recorded in a Tenant. Teams are Membership
subjects, not a separate primitive: wherever a Membership names a subject, the subject
is `PrincipalRef | Team`, and a Principal's effective access derives from the union of its
direct and team Memberships under the precedence rule of §3.3.

### 3.2 The Scope chain

**Scope** is one primitive with three roles forming a fixed chain
`Tenant ⊇ Project ⊇ Workspace`, with Project optional:

- a **Tenant** is the ownership and isolation boundary. It owns Projects, Workspaces,
  Teams, credentials, stored content, installed Packages, quotas, and retention. A
  single-user installation still has a Tenant — one Principal, one personal Tenant.
- a **Project** groups Workspaces for organization, policy, and sharing. It is a
  record owned by the Tenant's Actor, not a coordination unit of its own (§8.1,
  §10.1) — grouping your workspaces costs nothing at runtime.
- a **Workspace** is the composition boundary. It hosts Facet installs and the
  subject-local names selected by Bindings, plus Events, Subscriptions, Agents, Runs,
  and Slates, and enforces workspace policy. The Tenant Actor owns each canonical
  Binding alongside its backing Grants and path epochs; a Workspace retains only
  Binding ids or disposable lookup indexes.

The chain has one direction, and it carries declarations rather than records. Authority
and declared policy resolve downward along it: a live allow-Grant reaches every Scope
below the one holding it unless a deny on the ordered Tenant-to-target path removes it
(§3.3, §3.4), and quotas, retention, and the rest of a `PolicySet` (§9.2) resolve the
same way, which is what makes grouping Workspaces under a Project worth doing. Nothing
else traverses the chain. A record belongs to exactly the Scope that holds it: a Package
the Tenant installed becomes a Workspace's composition only through that Workspace's own
Facet install, so an ancestor's install MUST NOT compose into a descendant, and the
installed Facets a §4.2 slot policy admits as contributors are the queried Scope's own.
Events do not ascend either. An Event MUST be matched only by Subscriptions its accepting
Actor holds (§6.1, §6.2), so an `EventPattern` naming no Scope is confined rather than
ambient, and a Tenant that would react to a Workspace's Events declares a Subscription
whose delivery authority is checked (§6.2) rather than reading them by containment.
Containment is therefore a resolution path for what is declared and never an inheritance
of what is recorded, which is what keeps one Scope's composition and one Scope's history
from reaching another's without an authorized route. This maps to
**C13-AUTH-SCOPE-DIRECTION**.

*Why a fixed chain rather than arbitrary nesting:* two container levels are what most
mature resource hierarchies converged on (cloud providers, code forges), they cover
the sharing shapes that actually come up, and they keep policy resolution bounded at
three steps. Recursive workspaces would turn policy resolution, the UI, and the
substrate mapping into graph problems, and I have yet to see a platform that needed
them.

### 3.3 Membership, roles, and sharing

A **Membership** binds a subject (`PrincipalRef | Team`) to a Scope with a **Role**. A
**Role** is a named, declared set of authority rules:

```ts
interface Role {
  readonly name: RoleName;                         // "owner", "editor", "reader", …
  readonly rules: readonly RoleRule[];
}

interface RoleRule {
  readonly effect: "allow" | "deny";
  readonly capability: CapabilitySpec;
}
```

A `CapabilitySpec` describes one grantable authority: a Facet or Facet pattern, the
Operations (or Operation impacts) it covers, and any argument constraints. Rule order
is stable for materialization but does not alter precedence: any matching deny
overrides every matching allow. Roles are
declared in a Blueprint (`policies.roles`) or supplied by a Package; the spec fixes
three built-in roles every platform provides — `owner` (all capabilities at the scope,
including `administer`), `editor` (everything except `administer`), and `reader`
(`observe`-impact capabilities only) — each as allow rules, and platforms MAY declare
more rules including denies. A Role is a template; it becomes authority only when a
Membership assigns it. This stable rule order and allow/deny rule shape are what a
Membership materializes into Grants, and map to **C13-AUTH-ROLE-MATERIALIZATION**.

**Roles materialize Grants.** A Membership is not itself callable authority. Assigning
a Role at a Scope materializes — idempotently, exactly as a Blueprint materializes
records (§9.3) — one durable allow- or deny-Grant per Role rule, identified by
`(membership, rule ordinal)`, for that subject at that Scope. Reapplying the same Role
reconciles those Grants rather than adding authority. Downward flow, attenuation, and
revocation MUST operate only on Grants. The enforcement plane MUST resolve only Grants
and Bindings; Roles and Memberships have no second path. Revoking or changing a
Membership revokes its obsolete materialized Grants and advances the affected path
epoch (§3.4). A guest Membership materializes the same way after removing all allow
rules that could grant `delegate` or `administer`; deny rules are retained. This single
enforcement plane maps to **C13-AUTH-PLANE**.

*Why:* the moment roles and grants are two separate enforcement systems, they drift
apart, and that kind of drift tends to be discovered during an incident rather than
before it. With one plane, the question "what can this subject actually do" always has
exactly one answer, computed one way.

**Precedence.** Effective authority exists exactly when at least one live matching
allow-Grant reaches the target Scope and no live matching deny-Grant exists on the
ordered Tenant-to-target path. Direct and team Grants are considered together. A
descendant allow MUST NOT re-widen an ancestor deny; this deny-overrides precedence
maps to **C13-AUTH-DENY-PRECEDENCE**. Example: Team A holds `reader` on
Project P, so its members read every Workspace in P; a deny-Grant for W2 removes W2
without touching W1. A guest subject is matched by effect: an allow-Grant matches a
`ForeignPrincipalRef` exactly, `verifiedVia` included, so an allow issued to a guest
verified under one scheme is authority under that scheme only, while a deny-Grant
matches on `{ homeTenant, principalId }` alone. A deny names who is refused and
`verifiedVia` names only how that guest proved it, so a deny MUST NOT be escapable by
re-verifying under another scheme — and the stamp does change, both because a
`handshake` link downgrades to `token` and because one home Tenant may hold several
trusts at once.

**Sharing** is Membership issuance — there is no second mechanism. Sharing a Project
with a user is a Membership at that Project; a team owning a Project is a Team
Membership at that Project, and every member inherits access by default. Cross-tenant
sharing uses a **guest Membership** whose subject is a `ForeignPrincipalRef
{ homeTenant, principalId, verifiedVia }`. Guest-materialized Grants are always
attenuated, MUST NOT carry `delegate` or `administer` capability, and MUST NOT resolve
the host Tenant's credentials. Credential custody never leaves the owning Tenant. The
same Grant precedence and Binding resolver apply to guests. This prohibition maps to
**C13-AUTH-GUEST-ELEVATION**.

**Verifying a guest.** `verifiedVia` names how the host Tenant establishes that a
request actually comes from the foreign principal. It is one of three schemes, in
increasing order of coupling:

- `token` — the host and home Tenants share an out-of-band trust configuration (a
  signing key or an OIDC issuer URL registered in the host Tenant's policy). The guest
  presents a token issued by the home Tenant; the host verifies its signature and the
  `{ homeTenant, principalId }` claims against the registered issuer. This is the
  default and needs no live contact between tenants.
- `callback` — the host holds no key; at authorization time it asks the home Tenant's
  declared verification endpoint "is this token yours, and is this principal active?"
  and caches the answer for the token's lifetime. Used when the home Tenant will not
  share a key but will answer queries.
- `handshake` — for a first-time link, the two Tenants perform a one-time exchange (the
  home Tenant's owner approves the link, the host records the resulting trust
  configuration) that downgrades all future verifications to `token`. `handshake` is
  the bootstrap and never materializes a Grant itself; steady state is always `token` or
  `callback`, and a subject still stamped `handshake` at materialization MUST be denied.
  This maps to **C13-AUTH-GUEST-HANDSHAKE-BOOTSTRAP**.

Whichever scheme is used, the host verifies provenance *before* materializing any guest
Grant, and a verification failure denies. The wire protocol for a token or a callback
is a substrate/profile concern — the host Tenant's policy declares the issuer or
endpoint; this document fixes the three schemes and the before-materialization ordering.
This maps to **C13-AUTH-GUEST-VERIFICATION**.

### 3.4 Grant, Binding, resolution, revocation

A **Grant** is a durable authority rule: subject, Scope, `allow | deny` effect,
capability, origin, attenuation lineage, and revocation state. An allow may be
delegated only to an equal or narrower capability; a deny is not callable or
delegable. A **Binding** associates a subject-local name with an allow-Grant-backed
Facet instance in one protection domain. Binding resolution evaluates all matching
allow and deny Grants through §3.3 precedence. There is no deny list or role check
beside this plane. Callable access requires a **ResolvedFacet** produced by that
resolver; identifiers alone confer nothing. A Binding authorizes only the Operations
of the Facet it names; an Invocation whose Operation belongs to another Facet MUST NOT
be authorized by it. This maps to **C13-AUTH-BINDING-RESOLUTION**.

![One authority plane](diagrams/authority.svg)

```ts
interface PathEpochEvidence {
  readonly path: readonly [ScopeEpoch, ...ScopeEpoch[]]; // exact Tenant→target path
}

interface ScopeEpoch {
  readonly scope: ScopeRef;
  readonly epoch: number;
}

interface ResolutionStamp {
  readonly pathEpochs: PathEpochEvidence;
  readonly lease: LeaseToken;
  readonly originalLeaseExpiresAt: Date;
  readonly resolvedAt: Date;
  readonly resolutionDeadline: Date; // immutable; renewal cannot extend it
}

interface InvalidationWatermark {
  readonly holder: PrincipalRef;
  readonly delivered: readonly ScopeEpoch[]; // unique Scope keys; missing means epoch 0
}

abstract class AuthorityService {
  abstract assignMembership(scope: ScopeRef, subject: SubjectRef, role: RoleSpec): Promise<Membership>;
  abstract revokeMembership(membership: MembershipId): Promise<void>;   // revokes materialized grants, bumps epoch
  abstract grant(scope: ScopeRef, subject: SubjectRef, capability: CapabilitySpec,
                  attenuationOf?: GrantId): Promise<Grant>;
  abstract deny(scope: ScopeRef, subject: SubjectRef, capability: CapabilitySpec): Promise<Grant>;
  abstract revoke(grant: GrantId): Promise<void>;                       // disables descendants, bumps epoch
  abstract bind(domain: ProtectionDomain, name: BindingName, grant: GrantId,
                facet: FacetRef): Promise<Binding>;
  abstract resolve(domain: ProtectionDomain, name: BindingName): Promise<ResolvedFacet>;
  abstract memberships(principal: PrincipalId): Promise<readonly Membership[]>;
}
```

Authority rules:

1. Missing authority denies.
2. Delegation never widens: a delegated capability is equal to or narrower than its
   source, at every depth of the lineage, matching the Grant rule above. Where this
   document requires strict narrowing it says so at the site — guest-materialized
   Grants drop `delegate` and `administer` (§3.3), and `spawn` runs its child under
   attenuated Grants (§11.8).
3. Raw credentials remain in Tenant custody under §3.5; delegation moves capability stubs,
   not secrets.
4. Discovery is policy-controlled: a Turn receives a redacted view of installed Facets
   under the same policy that governs direct reads.
5. **Path evidence is complete.** Each Scope carries a monotonically increasing
   authority epoch. Every ResolvedFacet carries a `ResolutionStamp` whose
   `PathEpochEvidence` is the exact ordered
   Tenant-to-target Scope path and the current epoch of every Scope on it. It contains
   each path Scope exactly once, in order, with no omissions, duplicates, or extra
   Scopes. Evidence is
   fresh only if the path is still exact and every recorded epoch equals the current
   epoch. Creating, revoking, or changing any allow or deny advances the epoch of its
   Scope.
6. **Direct revocation has one bounded window.** Each holder has one Scope → epoch
   delivered invalidation map shared by all its resolutions. Delivery and observation
   join maps pointwise with `max`; entries never decrease. A direct-capable resolution
   records the expiry of the stamp's exact LeaseToken at issuance as
   `originalLeaseExpiresAt` and sets
   `resolutionDeadline = min(originalLeaseExpiresAt, resolvedAt +
   policy.maxDirectRevocationWindow)` at resolution; renewal never extends that
   immutable deadline. The configured window is finite and nonnegative. After a relevant epoch advances, let `deliveredAt` be invalidation
   delivery to the holder and `observedAt` be the first mediated check by that holder
   that observes any stale path epoch; an absent time is infinity. The resolution
   ceases to authorize direct calls at
   `min(deliveredAt, observedAt, resolutionDeadline)`. A direct call requires the
   stamp's exact Turn id, holder, and lease epoch to be current, current time strictly before the
   immutable deadline, and, for every Scope on its path, holder watermark ≤ recorded
   epoch.
7. **Mediated authority has one final admission point.** Actor-local mediation compares
   canonical authority and current path epochs in the guarded transaction that admits
   its EffectAttempt. Cross-Actor mediation performs that final comparison in the
   authoritative Tenant Actor only after the exact target claim, target fence,
   reservation epoch, item key, ordinal, arguments digest, and whole intent are known;
   issuing the §10.3 `AuthorityPermit` is the final authority-admission linearization
   point immediately before target attempt admission. Permit issuance linearizes
   against Grant, Binding-generation, and path-epoch mutation. Revocation committed
   before issuance blocks the permit; revocation committed after issuance cannot cancel
   the already admitted attempt, but blocks every not-yet-issued permit. Before permit
   issuance, or during Actor-local admission, a stale comparison atomically joins the
   current path Scope epochs into the holder map, invalidates the cached resolution,
   and records `deniedPreEffect` without an EffectAttempt. The target does not perform
   a contradictory second authoritative Grant/epoch decision; it validates and consumes
   the exact permit under `C13-CLOUDFLARE-AUTHORITY-PERMIT-CONSUMPTION`. This rule maps
   to **C13-AUTH-MEDIATED-ADMISSION** and **C13-AUTH-MEDIATED-STALE**.
8. Resolved-facet lifetime follows the isolation mode: `bundled` resolutions last no
   longer than their exact Turn and deadline — a held or cached resolution admits only
   while it still names the exact current LeaseToken for that Turn, so fencing,
   reclaiming, or completing the Turn ends it at once rather than at the next unrelated
   check. A **Turn step** is one iteration of the Turn's execution loop, the interval
   between two successive firings of the `turn.step` interceptor cut point (§4.4); the
   executor seam (§5.6) fixes what one iteration comprises and this document places no
   further structure on it. `provider`/`dynamic` resolutions last one Turn step: the
   capability stub they wrap MUST NOT be held or reused past the step in which it was
   obtained, and every mediated use of it — inside that step or any later one —
   independently re-authorizes against current path epochs regardless of how recently the
   resolution was obtained (§10.2, rule 7 above). This maps to
   **C13-AUTH-RESOLUTION-LIFETIME**.

*Why bounded-window rather than instantaneous:* no distributed substrate can update
every live holder atomically. Rules 6–7 give direct calls a safety bound without a
delivery-liveness assumption and require current evidence for mediated effects.
Eventual delivery and reconciliation use only the external liveness assumptions in
§14.

### 3.5 SecretRef

A **SecretRef** `{ source, provider, id }` names a credential held in Tenant custody.
Configuration, manifests, and Blueprints carry SecretRefs, never raw credential
values. A SecretRef is custody delegation, not process isolation: if plaintext is
readable in an agent-visible filesystem, the ref does not protect it. Substrates
SHOULD provide credential-injecting seams — proxy-injected headers, masked environment
variables — so raw values never enter agent-visible domains at all. The ref-only rule
maps to **C13-CONFIG-SECRET-REF**.

Custody is about who may present a credential, not only about where the bytes live. A
SecretRef resolves only inside the Tenant named by its `source`, and only for the exact
Binding and target endpoint that Tenant recorded when it accepted the credential:
repointing an integration at a new endpoint invalidates the old resolution rather than
presenting the old credential to the new place. `source` MUST equal the exact canonical
value of that Tenant's `TenantId` — never a free-form label — checked by whatever records
custody; `SecretRef` itself stays a self-contained core value type (§1.4) and does not
import the identity types it names. Acceptance is recorded custody: whichever Tenant-owned
consumer accepts a SecretRef for use (a Binding, an Environment, an ingress declaration's
`verification.secret`, or any other consumer this document or a profile names) durably
pairs it with the exact consumer identity and target endpoint the Tenant authorized — that
`(SecretRef, consumer, endpoint)` triple is the **custody record**. This document does not
fix where a substrate stores it beyond that it is Tenant-owned data under the one-owner
rule every durable record already follows (§8.4); it is a fact a consumer's own record
carries, not a new durable record kind. A resolution seam — the credential-isolation seam
of §4.5 is the one this document names, and a profile MAY name others — MUST check the
presenting consumer and target endpoint against the custody record before returning a
value, and MUST fail the resolution attempt, never degrade to the raw value, for a
mismatched or unrecorded pair. For a mediated `externalSend` effect that failure is an
ordinary failed AttemptReceipt (§7.4); custody denial needs no separate record kind or
vocabulary of its own. A delegation, a guest Membership, and a cross-tenant reservation
each carry the ref and never the value. §3.4 rule 3 and §3.3's guest prohibition are
consequences of this clause, which is the only place it is stated. This maps to
**C13-CONFIG-SECRET-CUSTODY**.

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
  readonly isolation: readonly [IsolationMode, ...IsolationMode[]]; // unique admissible modes (§9.2)
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

// A FacetSet is one composition view: the finite set of Facets one executing context
// composes, each named once by its canonical FacetRef (§1.4) and ordered by that
// serialization, so one view has exactly one form. It names its members and carries no
// ResolvedFacet: resolution stays with the §3.4 resolver, at each use.
type FacetSet = readonly FacetRef[];

interface OperationDescriptor<I = unknown, O = unknown> {
  readonly name: OperationName;
  readonly impact: Impact;                     // host-derived (§7.1)
  readonly input: JsonSchema;
  readonly output: JsonSchema;
  readonly help?: string;
  readonly interceptable?: true;               // consent for cross-facet interception (§4.4)
  readonly availability?: OperationAvailability; // §4.7 — absent is "native"
}

// Which callers an Operation is offered to (§4.7); absent is "native" alone.
type OperationAvailability = "native" | "code" | "both";

abstract class Operation<I, O> {
  abstract readonly descriptor: OperationDescriptor<I, O>;
  abstract execute(ctx: OperationContext, input: I): Promise<O>;
}
```

A **FacetSet** is one composition view: the finite set of Facets one executing context —
a Turn (§5.3) or a Session — composes, with each member named exactly once by its
canonical FacetRef (§1.4) and the set ordered by that serialization, so one view has
exactly one form and two readers of the same view cannot disagree about its membership. A
FacetSet names its members and holds none of their capabilities: a ResolvedFacet is
produced only by the §3.4 resolver, for the exact use and lifetime that rule allows, so a
context carries membership as data without carrying authority as state. `children()`
returns a Facet's child Facets on those same terms — the refs, never live stubs — which is
what makes a Facet's own composition inspectable without conferring anything.

The host verifies at install time that the runtime provides every implementation the
manifest declares and refuses contributions the manifest does not declare. This maps to
**C13-FACET-INSTALL-VERIFICATION**. Placement
uses the deterministic admissible-set rule in §9.2. A manifest listing `bundled` does not
thereby obtain it — the trust set independently excludes `bundled` for untrusted Packages
(§9.2) — and a manifest may exclude modes it will not accept.

A manifest declares what a Facet has and never what it lacks. Where a declared field is
the condition of a capability rather than a datum — `interceptable`, the target's consent
§4.4 requires before another Facet's interceptor may reach an Operation — it MUST be
present exactly when the capability is offered and absent otherwise, and a present
negative form MUST be refused at install rather than read as absence. A withheld
capability encoded as a value is a capability a reader can find, a policy can key on, and
a later edit can flip, and it gives one meaning two `manifestDigest` values where §5.2
pins a release by that digest; an absent key is none of those things. Nor does absence
read as a negative value the host then re-derives: it reads as the capability not being
offered, so the host implements no second path and holds no state in which the two
disagree. This document uses the same shape wherever a field carries a condition rather
than a datum — `terminal` on a retired Surface's last View (§6.3), `failure` on a failed
Receipt (§7.4) — and a capability this document declares by presence MUST NOT acquire a
negative encoding. This maps to **C13-FACET-CAPABILITY-ABSENCE**.

Facet lifecycle hooks are idempotent from the caller's perspective. Protected
invocation requires an active, undisposed Facet whose Grant, Binding, lease, and
revocation state are valid per §3.4. Turns dispose resolved Facets on completion,
failure, cancellation, suspension, or authority loss. This maps to **C13-FACET-DISPOSAL**.

**Withdrawal.** A Facet leaves a Scope by **withdrawal**, an `administer`-impact
Operation, never by deletion of its install record. Withdrawal is not disposal:
`C13-FACET-DISPOSAL` releases one Turn's resolution to a Facet and leaves the Facet
installed and resolvable by the next Turn, while withdrawal retires the install and
leaves the Facet resolvable by no later Turn. The Actor owning a record computes the
**withdrawal set** by querying attribution (§4.2), never by running an inverse the Facet
supplied: exactly the records naming the Facet as contributor — its slot entries, its
Slot declarations, its catalog entries, its derived Subscriptions, its Surface
registrations, its prompt sections, its ingress endpoints, and its settings fragments —
together with the Bindings naming its `FacetRef` and the Grants whose capability names
only its Operations. Withdrawal retires that set in one control transaction per owning
Actor. Because every materialized record carries attribution or is invalid (§4.2), that
query is total; a host that still cannot compute the set MUST refuse the withdrawal
rather than perform a partial one, and a record the set does not name is unchanged by the
withdrawal. Records this document declares append-only and undeletable — a Receipt, an
AuditRecord, a RunCommit (§8.2) — are never in a withdrawal set, and neither is an
emitted Event: retiring an `events` contribution retires the capacity to accept that
kind, never an occurrence already recorded under it, because an emitted effect is
evidence and withdrawal retires the capacity to emit rather than the evidence emitted.
Withdrawal releases no content either. Retiring a record drops that record's own
retainer edge and no other, so content any retained record still names stays retained
under `C13-CONTENT-CUSTODY`, and a withdrawal MUST NOT release a `ContentRef` a
RunCommit or an admitted inbox Event names — which is what keeps a model call's request
reconstructable from committed records (§5.6) across a withdrawal. Retiring the
Subscriptions a Facet's `commands` and `automations` contributions materialized closes a
routing liveness gap §6.2 otherwise leaves open, since a RouteReservation reaches a
terminal RouteDelivery only through its target's admission: withdrawal MUST retire those
Subscriptions in the transaction that begins it, so no further reservation is appended
against an unresolvable target, and the owning Actor — which outlives the Facet the intent
named — MUST admit every reservation already appended and not yet prepared to a terminal
rejected RouteDelivery. Retiring a Slot declaration never retires an entry another Facet
contributed, because exactness confines the set to the withdrawing Facet's own records; a
withdrawal whose set holds a Slot declaration carrying an entry attributed to a Facet the
same reconciliation retains is refused instead, because the retained contribution would
name a Slot the resulting composition does not declare. This maps to
**C13-FACET-WITHDRAWAL-EXACT**.

Withdrawal does not complete while any admitted Invocation item whose
`PreparedInvocationHeader.target` names the withdrawing Facet lacks a terminal current
Receipt (§7.4). Such an item is a pending obligation of the withdrawal exactly as an
admitted unfinished item is of Run settlement (§5.2): its intent, its placement, and its
Package pin are already frozen, so it settles against the Facet the intent named and
never against whatever later occupies that `FacetRef`. The transaction that begins a
withdrawal stops admitting Invocations against the withdrawing Facet, so the drain set is
finite at that transaction and never grows; a RouteReservation that reached preparation
drains as one of these items, and one the target has not admitted takes instead the
terminal rejected RouteDelivery the withdrawal set requires, which is what makes every
reservation against a withdrawn target terminable. A draining item's Receipt, its
reconciliation, and its audit chain are appended after withdrawal begins exactly as a
system writer appends evidence after a Turn is fenced (§5.2), and a host MUST NOT
discard, synthesize, or shortcut a draining item's Receipt in order to report a
withdrawal complete. This maps to **C13-FACET-WITHDRAWAL-DRAIN**.

Activation is all-or-nothing at the Scope's records. A Facet whose `start` does not
complete contributes no slot entry, no Slot declaration, no catalog entry, no
Subscription, no Surface, no ingress endpoint, and no settings fragment: the host retires
whatever the partial activation materialized through the same attributed withdrawal set a
withdrawal computes, and records the outcome as a typed failed install rather than as a
live Facet. Retiring a partial activation drains on the same terms as a withdrawal,
because an Invocation already admitted against the Facet is frozen intent and still
settles. A failed Facet is inactive, obstructs no other Facet's activation or withdrawal,
and is not retried against the same unchanged Scope, because a host that retried an
activation whose effect on the Scope it had not first retired would compose against state
no Blueprint declares. This maps to **C13-FACET-START-ATOMIC**.

A Facet's `BindingRequirement`s are its declared dependencies. `start` MUST NOT be called
until every requirement resolves to a live ResolvedFacet under §3.4: a Facet whose
requirements do not all resolve stays inactive rather than starting degraded, and a
requirement no Binding satisfies is a rejected install rather than a runtime failure.
Withdrawal runs the mirror order. A Facet whose `FacetRef` any active Facet's resolved
requirement names is **relied upon**, and its withdrawal is deferred — recorded as a
pending obligation under §9.3, never rejected and never silent — until no active Facet
relies on it. A withdrawing Facet keeps resolving its own requirements for the whole of
its own teardown, so a dependent torn down by its provider's departure still reaches that
provider while it stops. Because a requirement resolves through the Grant plane to an
exact `FacetRef` in an exact protection domain and never to a name, reliance names the
exact provider a dependent reached: a second Facet answering to the same capability
neither satisfies the requirement nor discharges the reliance. Reliance is independent of
the parent/child order `stop` follows, since a Facet is held by the requirements resolved
to it and never by its position in the child tree, and it is computable before any package
code loads from the Blueprint's declared Bindings and the installed manifests'
requirements — so a reliance cycle, and a retained Facet whose requirement names a
withdrawn one, each reject the Blueprint at validation (§9.2) rather than deadlocking a
live reconciliation. This maps to **C13-FACET-DEPENDENCY-ORDER**.

*Why the split:* everything a host, a registry, or the Blueprint validator needs to
know about a facet is data it can read without running anything. This is the property
that makes a config-defined platform possible at all — and it is the shape that both
VS Code extensions and the most successful open agent platforms independently arrived
at.

### 4.2 Contributions and slots

A **Contribution** is a typed, schema-validated manifest entry targeting a **Slot** —
the extension points of a platform. The spec defines the core slots; the `slots`
meta-contribution declares new ones. Contributions are data that compiles down to
existing primitives, and a conforming host MUST materialize them through the same paths
it offers imperatively, so declared and programmatic behavior cannot diverge. This maps
to **C13-FACET-CONTRIBUTION-MATERIALIZATION**.

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
interface SlotEntry {
  readonly slot: SlotName;
  readonly contributor: FacetRef;           // §4.1 attribution: which Facet contributed it
  readonly package: PackagePin;             // §5.2 release the contribution was read from
  readonly ordinal: number;                 // declared order within the slot
  readonly value: FacetData;                // validated against the slot's entrySchema
}

abstract class SlotCatalog {
  abstract query(slot: SlotName, viewer: SubjectRef): Promise<readonly SlotEntry[]>;
}
```

`query` MUST filter by the slot's visibility policy; the materializer (§9.3) MUST
reject contributions that violate the slot's contribute-authority. Core slots carry an
implicit default policy: contribute = any installed Facet in scope; visibility = the
same policy as direct reads (§3.4 rule 4). These map to **C13-FACET-SLOT-VISIBILITY**
and **C13-FACET-SLOT-AUTHORITY**.

Slot entries come in two flavors: *declarative* (the entry is data validated against
`entrySchema`; the reading Surface renders it) and *surface-backed* (the entry carries
a `SurfaceId`; an aggregating platform Surface embeds the referenced child Views —
refs, never live stubs, per §6.3). A `dashboard.card` slot is the canonical
surface-backed case: the platform's dashboard Surface queries the slot and composes
the contributed cards' Views.

Every record a contribution materializes into — SlotEntry, catalog entry, derived
Subscription, Surface registration, prompt section, ingress endpoint, and merged settings
fragment — carries the exact `FacetRef` of the Facet that contributed it and the
`PackagePin` of the release the contribution was read from. A SlotEntry's identity is the
digest of exactly its declared fields, so re-materializing the same contribution from the
same release yields that same entry rather than a second one, and a slot holds at most one
entry per contributor per ordinal, so a changed contribution supersedes its predecessor
rather than accreting beside it. Attribution is written in the
same transaction as the record it attributes and is immutable for that record's lifetime;
a materialized record carrying no attribution is invalid rather than unattributed, and a
host MUST refuse to materialize a contribution it cannot attribute. Attribution is what
makes withdrawal exact (§4.1) — the withdrawal set is a query over these fields, so it is
computable for every Facet without executing Facet code — and what lets a host answer,
from records alone, which Facet is responsible for any entry a Surface renders. This maps
to **C13-FACET-CONTRIBUTION-ATTRIBUTION**.

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
  readonly binding: BindingName;             // target capability for initiator authority
  readonly mapping?: FieldMapping;          // arguments → operation input (see below)
  readonly acceptedTrust?: readonly [TrustTier, ...TrustTier[]];
  readonly completion?: OperationRef;       // optional observe-impact completion provider
  readonly surfaces: readonly SlotName[];   // where discoverable (chat.composer, cli, palette)
}

interface SubscriptionTemplate {
  readonly source: EventPattern;
  readonly target: OperationRef;
  readonly binding: BindingName;
  readonly mapping?: PayloadMapping;
  readonly dedupe?: DedupePolicy;
  readonly authority?: "initiator" | "delegated";
}
```

Materialization is deterministic. A Command first applies `mapping`, or identity when
absent, and emits `command.invoked` with the validated Operation input at `/input`. Its
derived Subscription is exactly:

```ts
{
  source: {
    kind: "command.invoked",
    source: `${facetId}:${command.name}`,
    acceptedTrust: command.acceptedTrust ?? ["owner", "authenticated", "self"],
  },
  target: command.operation,
  mapping: [{ from: "/input", to: "" }],
  dedupe: "event",
  authority: { kind: "initiator", binding: command.binding },
}
```

An automation template defaults `mapping` to root-to-root identity, `dedupe` to
`event`, and `authority` to initiator using its `binding`. Delegated automation MUST be
explicit. Its `source.acceptedTrust` is always explicit and nonempty. These defaults map
to **C13-COMMAND-SUBSCRIPTION-DEFAULTS**.

The lifecycle, end to end:

1. **Install.** The materializer registers the command in each declared surface slot.
   Command `name` MUST be unique per surface slot per Scope; a collision rejects the
   later contribution unless the Scope configures an alias. Per-Scope visibility
   policy (§9.2) MAY disable individual commands. This maps to
   **C13-COMMAND-COLLISION**.

2. **Discovery.** Surfaces render catalogs via `SlotCatalog.query`. For dynamic
   argument completion beyond schema enums, the host MAY call the command's
   `completion` Operation (`observe` impact) with the partial argument context. The
   impact is what keeps completion off the mediated tier, and maps to
   **C13-COMMAND-COMPLETION-IMPACT**.

3. **Argument binding.** A Surface owns its input grammar and produces a `FacetData`
   value that validates against `arguments` before any Event is emitted. CLI token
   ordering, quoting, and flags belong to the CLI Surface profile, not this core
   contract. With no `mapping`, the validated value is passed through unchanged;
   otherwise the declared pure mapping produces the Operation input. The mapping and both
   schemas MUST be checked at install; the produced value MUST validate against the
   Operation input schema at execution. These map to **C13-COMMAND-INSTALL-MAPPING**
   and **C13-COMMAND-ARGUMENT-BINDING**.

4. **Invocation.** The surface emits `Event(command.invoked)` whose correlation MUST
   carry the originating `SurfaceId` and, when invoked from a conversation, the
   `RunRef`/branch. The derived Subscription routes it to the target Operation.
   The derived Subscription uses exactly the fixed defaults above; no inferred
   compatibility relation or alternate authority source is permitted. This maps to
   **C13-COMMAND-INVOCATION-CORRELATION**.

5. **Result.** The host MUST emit `Event(command.completed)` correlated to the
   invoking Event's id, carrying the Operation's output reference (or the failure).
   Surfaces that render a `commands` slot MUST subscribe to `command.completed` for
   their own invocations and render results via ViewDelta (§6.3). A command whose
   effect belongs in the conversation appends a RunCommit to the correlated Run under
   the invoker's authority. This maps to **C13-COMMAND-RESULT**.

A worked example — a deploy facet adds `/deploy` to a chat platform:

```ts
contributions: {
  operations: [{ name: "deploy.run", impact: "externalSend", input: DeployArgs }],
  commands: [{
    name: "deploy", title: "Deploy the current slate",
    arguments: DeployArgs, operation: "deploy.run", binding: "deploy",
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
point that can observe, block, or rewrite the value in flight. It is the one thing
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
  readonly mode: InterceptorMode;           // ordered band: every rewrite runs first
  readonly appliesTo: OperationSelector;    // DEFAULT: the contributing facet's own operations
  readonly priority: number;                // ties inside one mode: (priority, facetId, id)
}

abstract class Interceptor {
  abstract intercept(ctx: InterceptContext, value: unknown): InterceptResult;
}

// The value's type at each cut point is fixed by the table above; `unknown` is
// narrowed by `ctx.cutPoint`. An OperationSelector is a set of Operation patterns —
// `own(...)` for the facet's own operations, or a `{ facet, operation }` pattern
// (each field a literal or "*"-terminated prefix) for a declared-interceptable target.
interface InterceptContext {
  readonly cutPoint: CutPoint;              // which point fired (narrows `value`)
  readonly operation?: OperationDescriptor; // present at operation.before/after
  readonly turn?: TurnRef;                  // required only for Turn-bound cut points
  readonly interceptor: InterceptorId;      // self, for attributable rewrites (rule 5)
}

type InterceptResult =
  | { readonly proceed: true; readonly value: unknown }   // pass through or rewrite
  | { readonly proceed: false; readonly reason: string }; // block, scoped to appliesTo
```

Rules:

1. Interceptors run only within one protection domain; cross-domain interception MUST
   use asynchronous Events. This maps to **C13-INTERCEPTOR-DOMAIN-CONFINEMENT**.
2. `appliesTo` defaults to the contributing facet's own operations. Intercepting
   another facet's operations requires that facet to declare the operation
   `interceptable` and the interceptor's facet to hold a Grant for it. Sharing a
   domain confers no interception rights.
3. Ordering is total and deterministic: ascending `(mode, priority, facetId,
   interceptorId)`, where `mode` runs every `rewrite` interceptor ahead of every `gate`
   interceptor and dominates every local priority; interceptor ids MUST be unique within
   a Facet. Hosts record which interceptor last rewrote a value. This maps to
   **C13-INTERCEPTOR-ORDER**.
4. A thrown error blocks — scoped to the interceptor's `appliesTo`, surfaced as a
   typed operation error, never as a silent global veto.
5. Mutating interceptions are attributable: the host records interceptor identity plus
   before/after value digests through the mediated audit channel. There is no second
   channel to choose between, because an applicable interceptor raises the call to
   mediated (§7.2); a direct invocation that presented interception evidence would be an
   invalid state rather than a case to record.
6. `operation.before` completes before preparation. Its final rewritten input is what
   the PreparedInvocation freezes and structurally digests. An interceptor MUST NOT
   rewrite a PreparedInvocation, Approval, EffectAttempt, or effect arguments
   afterward. This maps to **C13-INTERCEPTOR-POST-PREPARATION**.
7. The host persists the ordered `operation.before` transformation trace, including
   each interceptor identity and before/after digest, with the PreparedInvocation. A
   replay reuses the persisted transformed input and trace and does not rerun mutating
   pre-effect interceptors. A new interceptor pass creates a new InvocationId and
   whole-intent digest.
8. `operation.after` may rewrite only the returned presentation value; it cannot alter
   the effect, Receipt, or audit lineage. The host persists its ordered transformations
   and trace with the returned invocation evidence. Replaying the same invocation
   presentation reuses that persisted post-effect value and trace and does not rerun
   `operation.after`. These replay clauses map to **C13-INTERCEPTOR-REPLAY**.
9. `mode` states what an interceptor is, and `priority` states only how it breaks ties
   against its neighbours in the same mode, so no priority reaches across modes. A
   declaration whose mode is absent or outside the union is refused at contribution: a
   defaulted mode is an ordering claim its author never made, and independently authored
   Facets share one cut point without sharing a numeric scale, so a later contributor's
   number would otherwise silently reorder a semantic decision. This maps to
   **C13-INTERCEPTOR-MODE-DECLARED**.
10. A `gate` interceptor observes and may block, and MUST NOT rewrite: a `gate` result
    whose value differs from the value it received is an invalid state, refused as a
    scoped block naming that interceptor. Every rewrite therefore precedes every gate at
    a cut point, each gate reads the final value of that cut point rather than an
    intermediate one, and the mutating distinction the attribution and replay clauses
    depend on is declared rather than discovered from a completed run. This maps to
    **C13-INTERCEPTOR-MODE-FIDELITY**.

Example: a policy facet contributes `{ cutPoint: "operation.before", mode: "rewrite",
appliesTo: own("web.fetch"), priority: 10 }` that rewrites outbound URLs onto an
allowlisted proxy — its own operation, no opt-in needed, and the rewrite is
digest-logged.

### 4.5 Environment and Session

An **Environment** is an execution endpoint that opens live **Sessions**; a Session
exposes session-scoped child Facets (`env.fs`, `env.shell`, `env.ports`, `env.proc`).
An Environment is the agent's computer.

Rules: stale Sessions MUST fail; closing a Session MUST dispose its child Facets;
rotation MUST change future Sessions without retargeting open ones. These map to
**C13-ENVIRONMENT-STALE-SESSION**, **C13-ENVIRONMENT-DISPOSE-CLOSE**, and
**C13-ENVIRONMENT-ROTATION**. Environment profiles further define
**snapshot/restore** (boot from a known image), **ephemeral-filesystem durability**
(backup and restore for container-backed environments), **preview exposure** (how a
port becomes an authenticated URL), and the **credential-isolation seam** (secrets
injected by proxy, never present inside the environment).

A Session is **Turn-owned** when exactly one Turn opened it, no other Turn may use it,
and it closes when that Turn reaches a terminal status. A Turn-owned Session cannot be
shared and cannot outlive its Turn, which is what makes its contents reachable by that
Turn alone. §7.2 keys an enforcement floor on this property, so it is a condition a
platform tests rather than assumes. This maps to **C13-ENVIRONMENT-TURN-OWNED**.

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
- the Slate backend is agent-authored code (§4.7): it executes in the `dynamic`
  isolation mode with zero ambient authority, and capabilities arrive only through
  explicitly passed Bindings;
- publishing or embedding a Slate contributes Surfaces; app-private data is owned by
  the Slate's Actor.

Operations: `update`, `commit`, `fork`, `publish`, `deploy`, `rollback`.

### 4.7 Agent-authored code

Three consumers execute code the agent wrote. **Programmatic tool calling**: a Turn
submits code that strings Operation calls together, the host runs it once, and the
returned value is the tool call's result — one isolate per submission, gone when the
submission ends. **Slate backends** (§4.6): durable, versioned application code.
**Agent-authored facets**: ordinary Facets whose Package the agent produced, installed
and alive as long as any install references them. The three differ in lifetime and in
nothing else, and this section states the shared shape once so they cannot drift apart.

The shape is a composition of primitives this document already has, not a seventeenth:
placement (§9.2) puts the code in a `dynamic` domain — the trust set never hands
agent-authored code `bundled`, and holding nothing is the point of it — which §1.5
strips of ambient authority and ambient egress; the capability set arrives only as
explicitly passed Bindings; every call the code makes against one is an ordinary
Invocation, tiered by §7.2; and nothing crosses back out except the code's returned
value and asynchronous Events. From the model's side a programmatic tool call is one
Operation invocation — code in, value out — while every Operation the code called in
between carries its own admission and evidence.

Handing the capability set to the isolate is not transport; it is delegation. §1.5
already says nothing else crosses a domain boundary, and the §3.4 rules bound the
passed set exactly as they bound any other delegate: equal at most, never wider, deny
not delegable. The isolate's Invocations present its own delegated authority — never
the authority of the code that loaded it — so revoking a passed Grant severs the
isolate without touching its loader. This maps to **C13-AUTH-ISOLATE-DELEGATION**.

One `dynamic` semantics does not mean one hosting mechanism. A substrate profile MAY
offer more than one backing for loaded code — §10.2 names two, `workerLoader` and
`dispatchNamespace` — identified by a substrate-defined, opaque, nonempty id; this
document fixes no enum of them. A platform declares which backing serves each of the
three consumers this section names — programmatic tool calling, Slate backends,
agent-authored facets, a closed set, since nothing else is agent-authored code under
this section — as part of `policies.placement` (§9.2): one more mapping,
consumer → backing id, alongside the isolation-mode admissibility that record already
declares, not a new artifact. A consumer the Blueprint does not map uses the profile's
declared default backing. Every offered backing MUST preserve identical authority
semantics — zero ambient authority, zero ambient egress, capabilities only as explicitly
passed Bindings — so the choice between backings is operational, never an authority
decision; each backing demonstrates this independently, the same way any `dynamic`-mode
implementation does (§1.5's no-ambient-egress requirement), never by comparison
against another backing. This maps to **C13-PLACEMENT-AUTHORED-BACKING**.

Which Operations agent-authored code may reach is declared, not discovered. An
`operations` contribution states each Operation's `availability` — `native` to the model
as a tool call, `code` to agent-authored code, or `both` — and an absent declaration is
`native`, so an author who never considered code mode offers it nothing. Availability is
a property of the composition rather than of a submission: a Turn's captured FacetSet
(§5.3) fixes it for that Turn, and the materialized record carries its contributor's
attribution like every other contribution (§4.2), so it enters a withdrawal set with the
Facet that declared it (§4.1). The Bindings passed into an isolate MUST name only `code`-
or `both`-available Operations, bounded further by the §3.4 delegation rules, and an
Operation declared `native` MUST NOT be passable — so the catalog offered to the model
and the set the isolate can reach are one declared set rather than two a host keeps in
agreement, and the offered catalog §5.6 requires to be reconstructable is the same fact
the isolate enforces. A declaration the platform cannot serve — a `code` or `both`
Operation where `policies.placement` maps the programmatic-tool-calling consumer to no
backing and the profile declares no default (§9.2) — MUST reject the Blueprint at
validation before any package code loads, never at the first submission that needs it,
because an Operation the model was offered and the isolate cannot reach is a catalog that
was already wrong when it was assembled. This maps to **C13-FACET-CODE-AVAILABILITY**.

---

## 5. Execution (L2)

### 5.1 Agent

An **Agent** is durable identity, profile, and policy: instructions, model policy (a
ModelPolicy seam — providers are out of scope), ambient and bound Facet specs, memory
and task relationships, Run history. A model call happens only inside a Turn. This maps to
**C13-TURN-MODEL-CALL**.

### 5.2 Run, RunBranch, RunCommit

A **Run** is a branchable, durable work session and conversation lineage. It owns
input history, RunBranches (named movable heads), RunCommits (immutable records:
root, message, checkpoint, invocation, event delivery, result, merge, verdict, undo,
migration), status, an optional parent Run, and results. There is no separate
conversation primitive — conversation state *is* the Run's branch/commit graph.

```ts
interface RunPins {
  readonly blueprint: { readonly id: BlueprintId; readonly version: SemVer;
      readonly digest: Digest };
  readonly packages: readonly PackagePin[]; // complete transitive closure, unique by id
  readonly agent: { readonly id: AgentId; readonly revision: Revision;
      readonly digest: Digest };
  readonly effectivePolicy: { readonly id: PolicySetId; readonly revision: Revision;
      readonly digest: Digest };
  readonly modelPolicy: { readonly id: ModelPolicyId; readonly revision: Revision;
      readonly digest: Digest };
  readonly environment: { readonly id: EnvironmentId; readonly revision: Revision;
      readonly digest: Digest };
}

interface PackagePin {
  readonly id: PackageId;
  readonly version: SemVer;                  // exact, never a range
  readonly manifestDigest: Digest;
  readonly codeDigest: Digest;
}

interface TurnPlacementSnapshot {
  readonly turn: TurnId;
  readonly pins: RunPins;
  readonly placements: readonly PlacementPin[]; // every resolved Facet, unique by ref
}

interface PlacementPin {
  readonly facet: FacetRef;
  readonly manifest: readonly IsolationMode[];
  readonly policy: readonly IsolationMode[];
  readonly substrate: readonly IsolationMode[];
  readonly trust: readonly IsolationMode[];
  readonly selected: IsolationMode;
}

type RunLifecycle =
  | { readonly kind: "active" }
  | { readonly kind: "terminal"; readonly outcome: "succeeded" | "failed" | "cancelled";
      readonly terminalCommit: RunCommitId; readonly obligation: SettlementObligation;
      readonly exhausted?: "tokens" | "wallClockMs" | "depth" | "costMicros" }; // ceiling only

type RunObligation =
  | { readonly kind: "approval"; readonly approval: ApprovalId }
  | { readonly kind: "invocationItem"; readonly invocation: InvocationId;
      readonly itemIndex: number; readonly itemKey: string }
  | { readonly kind: "route"; readonly reservation: RouteReservationId }
  | { readonly kind: "reconciliation"; readonly attempt: EffectAttemptId }
  | { readonly kind: "systemCommit"; readonly commit: RunCommitId }
  | { readonly kind: "acceptance"; readonly acceptance: AcceptanceId };

interface AcceptanceCriterion {
  readonly id: AcceptanceId;
  readonly operation: OperationRef;           // the verifier, an ordinary Operation
}

interface AcceptanceVerdict {
  readonly acceptance: AcceptanceId;
  readonly subject: Digest;                   // head tree digest the verifier saw
  readonly receipt: ReceiptId;                // its attempted Receipt
}

interface RunAdmissionRegistry {
  readonly run: RunId;
  readonly epoch: number;
  readonly open: boolean;
  readonly reserved: readonly RunObligation[];  // unique canonical identities
  readonly completed: readonly RunObligation[]; // subset of reserved
}

interface RunAdmissionReservation {
  readonly run: RunId;
  readonly registryEpoch: number;
  readonly obligation: RunObligation;
}

interface SettlementObligation {
  readonly registryEpoch: number;
  readonly obligations: readonly RunObligation[];
  readonly requiredAudits: readonly SettlementAuditObligation[];
}

interface ForcedTurnCancellation {
  readonly run: RunId;
  readonly terminalTurn: TurnId;
  readonly turn: TurnId;
  readonly priorLeaseEpoch: number;
  readonly fencedLeaseEpoch: number;
  readonly controlReceipt: ReceiptId;
  readonly controlAudit: AuditRecordId;
  readonly cancellationEvent: EventId;       // token-scoped turn.cancel inbox evidence
  readonly cancellationAudit: AuditRecordId;
}

interface SettlementAuditObligation {
  readonly audit: AuditRecordId;
  readonly evidence:
    | { readonly kind: "receipt"; readonly invocation: InvocationId;
        readonly receipt: ReceiptId }
    | { readonly kind: "delivery"; readonly reservation: RouteReservationId }
    | { readonly kind: "commit"; readonly id: RunCommitId };
}

interface ResourceCeiling {
  readonly tokens?: number;
  readonly wallClockMs?: number;
  readonly depth?: number;
  readonly costMicros?: number;              // millionths of one currency's major unit
}
```

`PackagePin.id` identifies the distributable Package release, not a contained
`FacetManifest.id`. `PackageId` and `FacetPackageId` are distinct opaque identities and
MUST NOT be converted or compared by string value. One Package may contain multiple
independently identified FacetManifests. This maps to **C13-RUN-PIN-IDENTITY-TYPES**.

- Starting a Run creates one root RunCommit and immutable **RunPins** fixing the exact
  Blueprint id, version, and digest; complete transitive Package version closure; Agent
  id, revision, and digest; effective PolicySet id, revision, and digest; ModelPolicy
  id, revision, and digest; and Environment id, revision, and digest. `Run.agent` MUST
  equal `RunPins.agent.id`, and the complete Package closure MUST be nonempty and unique
  by `PackagePin.id`. Package ranges never appear in RunPins.
  Every referenced source record and Package release remains resolvable while any Run,
  Turn, Session, tree checkpoint, or Snapshot pins it. These exact identities map to
  **C13-RUN-PINS-SOURCES**, **C13-RUN-PINS-ENVIRONMENT**, and
  **C13-RUN-PINS-VALIDITY**.
  Every commit names its RunPins. Every non-root, non-migration unary commit inherits
  its exact parent's pins; a merge requires equal pins on both parents. **Run migration** is
  an `administer`-impact Operation that appends a unary migration commit naming exact
  `from` and `to` RunPins; its parent uses `from` and the migration commit uses `to`.
  Before installation, the target `to` pins MUST satisfy the same
  `RunPins.Valid(Run.agent)` constraints as Run creation; invalid Agent identity,
  empty/duplicate Package closure, or malformed source identity rejects without
  appending or installing the migration commit.
  A Turn retains the pins captured at its start; only Turns
  started from the migration commit or its descendants use the new pins. Migration is
  never implicit, and branches with different pins cannot merge until explicitly
  migrated to equal pins. Parent inheritance maps to
  **C13-RUN-PARENT-PIN-INHERITANCE**.

- Each Turn separately captures one immutable **TurnPlacementSnapshot** after §9.2
  selection. RunPins do not encode placement, and later policy or substrate changes do
  not retarget that Turn. Terminalization requires the terminal Turn's snapshot pins to
  equal the Run's current pins and its terminal commit to inherit those exact pins from
  the current head. A Turn retained across migration keeps its old pins and MUST be
  rejected as terminalizer after the Run migrates. These pin-validity clauses map to
  **C13-RUN-MIGRATED-TURN-REJECTION**.

- Before any Run-associated Approval, Invocation item, RouteReservation,
  reconciliation, or required system commit is admitted locally or remotely, the
  Run-owning Actor MUST reserve its canonical `RunObligation` in the durable
  `RunAdmissionRegistry` transaction. Reservation uses only identities known before
  remote work: ApprovalId; InvocationId plus item index and item key;
  RouteReservationId; EffectAttemptId for reconciliation; or planned RunCommitId.
  Receipt, delivery, projection, and Audit ids are never reserved. Duplicate canonical
  keys reuse the existing reservation. Completion atomically adds that exact reserved
  identity to `completed`; an unreserved identity cannot complete. Every remote actor
  validates the exact `RunAdmissionReservation` identity, Run, and registry epoch before
  admission; a substituted identity or closed/changed epoch rejects. This maps to
  **C13-RUN-ADMISSION-REGISTRY** and **C13-RUN-RESERVATION-EPOCH**.

- **Terminalization** is one Run-owner transaction: close the admission registry,
  advance its epoch, snapshot exactly `reserved − completed`, append the
  terminal result commit under the exact current Turn token, fence that Turn, record the
  Run outcome, and capture one finite SettlementObligation. Every sibling Turn MUST
  already be both terminal and unheld, or, only while this terminalization is open, the
  system MUST force-cancel it through the closed §5.3 rows. The sibling MUST be a
  distinct Turn in the same Run. One exact successful `administer` control Receipt and
  its matching AuditRecord authorize the sequence. Each cancellation fences the
  sibling, appends token-scoped `turn.cancel` inbox and Audit evidence, and records
  `ForcedTurnCancellation` with both fence epochs and the exact control evidence.
  Forced cancellation appends no sibling result commit and never presents or
  impersonates the sibling's LeaseToken or `CommitWriter.turn`.
  Terminalization commits only after every sibling is both terminal and unheld. No
  running sibling retains admission. This maps to **C13-RUN-FORCED-CANCELLATION**. Once closed, the Run rejects new routes,
  preparations, Turns, migrations, merges, undo, and other control writes; system
  writers may complete only captured evidence obligations.

- The terminal snapshot is exactly the just-closed registry's reserved-minus-completed
  set, not a remote discovery
  query: all pending Approvals, admitted Invocation items without a terminal current
  Receipt, RouteReservations without terminal delivery, EffectAttempts requiring
  reconciliation, and required system commits. It
  contains no completed or unreserved work. The finite registry MAY honestly be empty
  when no reservation was admitted; empty does not mean discovery was skipped. This
  maps to **C13-RUN-FRONTIER-COMPLETE** and
  **C13-RUN-FRONTIER-EMPTY**.

- Terminal does not assert all asynchronous evidence has arrived. **Settled** is
  derived, never assigned: a Run is Settled exactly when every captured Invocation item
  has a terminal current Receipt, no indeterminate Receipt is current, every captured
  RouteReservation has delivery or terminal rejection evidence, and every captured
  system RunCommit exists. Every required audit obligation MUST resolve to an existing
  AuditRecord of the stated evidence kind whose typed causal chain reaches that exact
  terminal Receipt, route delivery, or commit. Every captured Approval MUST resolve for
  its exact Invocation as consumed, denied, or expired. Every captured reconciliation
  MUST resolve the exact captured indeterminate Receipt to one final Receipt for the
  same EffectAttempt with the required `receiptSuperseded` lineage. Every captured
  acceptance criterion MUST hold a current satisfying verdict. BatchOutcome is available when every item has
  a current Receipt; its terminal form additionally requires non-indeterminate outcome.
  This maps to **C13-RUN-SETTLED-DERIVED**.

- `spawn` creates a child Run under attenuated authority (`delegate` impact, §11 Self
  profile).

- The commit graph MUST be **append-only**. An `undo` appends an undo RunCommit `U`
  whose parent is the current head and whose `selects` field names an ancestor commit;
  the branch head advances to `U`, and the branch's **effective state** becomes the
  selected commit. Redo appends another undo commit selecting the prior effective
  commit. The interval until the next non-undo commit is the **pending revert**: it is
  durable and reversible. Prior heads remain reachable; ancestry
  queries are unaffected. This maps to **C13-RUN-UNDO-REDO**.

- Undo targeting a branch with a held Turn MUST first fence that Turn (§5.3), whether or
  not its lease has expired — an expired lease is still reclaimable until someone fences
  it. An undo that would orphan an in-flight Turn is rejected until the Turn is fenced or
  completes. This maps to **C13-RUN-UNDO-FENCE**.

- `merge` is binary: it appends one RunCommit whose ordered parents are exactly the
  target branch's current head followed by the distinct source branch's current head.
  Multiway merge is a deterministic left fold of binary merges in caller-supplied
  branch order. A merge records one of the three content resolutions in §5.2.1; the
  graph records lineage and does not compute content.

- Conforming stores MUST support ancestry and reachability queries, not merely head
  moves. This maps to **C13-RUN-ANCESTRY**.

The **canonical graph** MUST have one root with zero parents; every non-root, non-merge
commit has exactly one parent equal to its branch head at append; every merge has
exactly the two parents above; and no other parent arity is valid. Appending atomically
advances only the target branch head. Commit records and parent order never change.
This maps to **C13-RUN-GRAPH-ARITY**.

A Run's commit graph is closed over that Run. Every RunCommit names the Run it belongs to,
that Run owns the RunBranch the commit's `branch` field names, and every parent a commit
names MUST be a commit of the same Run — its unary parent, and both merge parents, whose
source MUST be a distinct branch of that same Run rather than whichever branch happens to
stand at the named head. Closure is what makes a Run's ancestry a record of what the Run
itself authored, and the derivations this section takes over ancestry depend on it:
effective state, the effective transcript, a cut's balance, and the ancestors a rewrite may
shadow are each computed by walking parents, and each would answer about another Run's
material once any is spliced in. A `wallClockMs` remainder depends on it differently — it
measures from the Run's root RunCommit, and a spliced ancestry gives the graph a second
zero-parent commit and that measurement a second candidate origin. A child Run therefore
holds no inherited history to tell apart from its own: `spawn` creates a Run with its own
zero-parent root, and whatever the parent hands it — a task statement, an excerpt of the
parent's transcript, a digest — arrives as the content of a commit the child appended under
the child's own writer evidence, attributed to the child and shadowable by a later rewrite
on the child's own branch. A platform that instead seeded a child by replaying the parent's
commits into the child's graph would owe every child a durable watermark saying where
inheritance ends, and each derivation named here would have to consult it or be computed
over material the child did not author. This maps to **C13-RUN-GRAPH-CLOSED**.

A branch's effective state answers which commit is current; it does not answer what a model
reads. The **effective transcript** is the second derivation over the same append-only
graph: the model-visible content of the effective state's ancestry in commit order, with
every commit a **rewrite** commit shadows omitted and that rewrite's own content read where
they stood. A rewrite appends a RunCommit whose parent is the current head and whose
`shadows` field names the exact commit identities it removes; each MUST be a distinct
ancestor present in the effective transcript at the rewrite's parent, so a rewrite cannot
claim to remove something a reader cannot see it removing. Nothing is mutated and nothing is
deleted. A shadowed commit keeps its identity, its content, its parents, and its
reachability; ancestry queries answer exactly as they did before; and because a RunCommit is
append-only and undeletable it still retains the content it names (§8.2). Shadowing reduces
what the next model call sends and never releases what an earlier one read. `shadows` names
identities rather than a positional span because a rewrite is appended at the head while the
commits it shadows lie deep in the ancestry: once one rewrite exists, the commits a second
rewrite covers are not an interval in any order the graph has, and a span would stop naming
them at exactly the moment a span is wanted. This maps to
**C13-RUN-EFFECTIVE-TRANSCRIPT**.

A rewrite is not one instant. Choosing what to shadow, producing the replacement — a
summarized replacement is itself a model call, so by C13-TURN-MODEL-CALL that work runs
inside a Turn — and installing the result span an interval, and the branch MUST NOT move
under an attempt in progress. The bracket around that interval is built from records this
document already has. Before the attempt begins, the Run-owning Actor reserves the planned
rewrite's `RunCommitId` as a `systemCommit` RunObligation, and a branch holds at most one
reserved and uncompleted rewrite obligation, so a second attempt on that branch is rejected
rather than raced. The bracket closes by appending exactly that reserved commit, in one of
two forms. An installed rewrite names a successful `administer` control Receipt and the
commits it shadows. An abandoned rewrite names that attempt's failed `administer` Receipt,
shadows nothing, and changes no transcript; it is the one commit this document admits on
failed control evidence, and the closed failure kind on that Receipt (§7.4) already says why
the attempt ended. Both forms complete the obligation, so an attempt that produced nothing
neither blocks settlement nor disappears. Keeping the failure is the point: under context
pressure, a reduction that silently did not happen is indistinguishable from one nobody
tried, and those two states differ by whether the next call fits. When to attempt a rewrite,
how much to shadow, whether the replacement is summarized by a model or assembled without
one, and how remaining context is measured are host discretion — this document specifies a
platform, not a compaction engine. This maps to **C13-RUN-REWRITE-BRACKET**.

Every operation that makes an effective transcript something other than a full ancestry
replay is a **cut**: an undo's selection, a branch created at a commit that is not its
parent branch's head, and a rewrite's shadow set. A cut MUST leave a well-formed transcript,
and well-formedness is one closure property over Invocations — every `invocation` commit the
transcript retains answers a request the transcript still contains, and every request it
retains keeps its `invocation` commit. A cut that keeps a request whose result it dropped
leaves the next model call ending on an Invocation nothing answers; a cut that keeps a
result whose request it dropped leaves one answering an Invocation the model never made.
Providers reject both, so a cut that would produce either is rejected before it lands rather
than repaired afterwards. Deciding this requires the pairing to live in the graph and not
inside opaque content, so a `message` commit whose content requests Invocations names them
in `requests` while the `invocation` commit already names the same identity: a cut is then
judged on which Invocation is unanswered rather than on how many are. This maps to
**C13-RUN-CUT-BALANCE**.

A Run MAY declare **acceptance criteria** when it opens, so that finishing is something it
proves rather than something it asserts. Each criterion names an Operation that decides
whether the work is done, and the Run-owning Actor reserves its `AcceptanceId` as an
`acceptance` RunObligation. An `AcceptanceId` is unique across the store, so two Runs
cannot declare the same criterion identity with different verifiers and a verdict names
exactly one criterion. The obligation is never completed as bookkeeping: it stays
outstanding and is snapshotted at terminalization like any other, and it is discharged only
by evaluation at settlement. It is satisfied exactly when an `AcceptanceVerdict` for that
`AcceptanceId` names an attempted Receipt whose outcome is `succeeded` and whose `subject`
equals the Run's current head tree digest — the tree digest of the head of the Run's
`initialBranch`, the one branch the Run record itself names, so that satisfaction is never
selectable by the caller that asks. Completing it when the verdict arrives would freeze it
against whatever tree was current at that instant, and a later commit carrying a new
`treeCheckpoint` would leave the Run settling on a proof about a tree it no longer has. The verifier is an ordinary
Operation, so its Receipt carries the whole §7 admission and audit chain, and the Receipt
MUST come from the exact Operation the criterion names — a succeeded Receipt from any other
Operation is not evidence for this criterion, or the declared verifier would be decoration
and any success anywhere would discharge it. An unsatisfied acceptance obligation is exactly as
unfinished as an outstanding Approval: it is snapshotted into the SettlementObligation and
the Run is not Settled while it stands. A criterion bounds nothing — not time, not cost,
not attempts — and a Run that declares none is settled by the same rule as before. This
maps to **C13-RUN-ACCEPTANCE-OBLIGATION**.

A verdict is evidence for its exact `subject` and for nothing else. While a criterion
holds a verdict naming the current head tree digest, that verdict is current evidence and
the system MUST NOT run the verifier again. A further attempt is admissible only against a
head tree digest that no recorded verdict for that criterion names, so what makes a retry
possible is changed input rather than elapsed time or a counted attempt. A Run therefore
cannot spin against inputs it has not moved, and one that keeps failing is visible as a
criterion undischarged across distinct subjects. This maps to
**C13-RUN-ACCEPTANCE-SUBJECT**.

A `delegate`-impact spawn MAY attenuate resources alongside capability, by carrying an
optional `ResourceCeiling` on the spawn's attenuation — the same content-addressed
attenuation `SpawnReservation.attenuation`'s digest already commits (§5.2), not a new
record. The same rule governs it as governs capability (§3.4 rule 2): a child ceiling MUST
NOT exceed the parent's remaining allowance in any declared dimension, and a dimension the
child does not declare inherits the parent's remainder. A Run that declares no ceiling is
unbounded — the platform imposes none — so fan-out narrows downward without anything
capping work nobody chose to bound. This maps to **C13-RUN-RESOURCE-CEILING**.

The declared dimensions differ in how their remainder is known. `depth` and `wallClockMs`
MUST be derived, never separately accounted: depth is the length of the spawn lineage
from the Run back to the ancestor that declared the ceiling, and wall-clock consumption
is the current time minus the Run's root RunCommit timestamp — both computable from
records this document already requires, with no running total to maintain. `tokens` has
no such derivation: consuming it needs a durable running total per Run, which a host
MUST accumulate at the same point a model call commits (§5.1, C13-TURN-MODEL-CALL) — a
counter this document requires without further shaping its storage, left to the executor
seam (§5.6) like every other model-call detail. This maps to
**C13-RUN-CEILING-REMAINDER**.

`costMicros` bounds money, and it belongs to the second class: there is nothing to derive
it from, so a host MUST accumulate realized cost as a durable per-Run running total at the
same commit point the token total advances. What makes it unlike `tokens` is that the
platform does not observe it — a token count arrives in the model response, while a price
comes from a provider rate that varies by model, by contract, and over time — so this
document requires the recorded amount to be cost the call actually incurred and leaves the
rate source out of scope, at the executor seam (§5.6) with every other model-call detail.
Recording realized cost rather than an estimate is what keeps the ceiling enforceable
instead of advisory: exhaustion is then a fact about spend, on exactly the granularity
`tokens` already has — the call that crossed the ceiling has committed by the time the
crossing is known — whereas a remainder computed from a rate table would make exhaustion a
claim about that table. A host with no realized cost to record declares the dimension
nowhere, and by C13-RUN-RESOURCE-CEILING that bounds nothing; it MUST NOT substitute an
estimate. Amounts are integer millionths of one currency's major unit, and a host MUST
record every realized cost in a Run lineage in one currency, because a comparison between
amounts in two currencies is not a comparison and a ceiling is nothing but that
comparison. This maps to **C13-RUN-CEILING-COST**.

Exhaustion is neither silence nor a new mechanism: the host cancels the Run through the
closed §5.3 rows with outcome `cancelled` and the exhausted dimension recorded in
`RunLifecycle`'s terminal `exhausted` field, and the Run's acceptance criteria still say
whether the work was finished, so an exhausted Run with an undischarged criterion reads as
exactly that. A ceiling is scheduling state, like claim expiry (§7.4); it never appears in
authority admission and changes no admission decision. This maps to
**C13-RUN-CEILING-EXHAUSTION**.

#### 5.2.1 Merge resolution and tree conflicts

Two things can be in conflict at a merge: the *conversation* and the *filesystem tree*.
They are handled separately, because §5.4 already separates their checkpoints.

**Conversation resolution.** A merge's `resolution` names one of three kinds over its
ordered pair of parents:

- `pick` — the content is one parent's content verbatim (the chosen branch wins). The
  resolution records which parent was picked.
- `concat` — the content is the parent-order concatenation of their contents (used
  when the branches contributed to disjoint parts of the answer).
- `synthesize` — the content is produced by an aggregating Turn that read the parent
  heads. The resolution records its exact LeaseToken and a successful `execute`
  Receipt whose PreparedInvocation binds that token and whose result is the synthesized
  content. A separate successful `administer` control Receipt authorizes the system
  writer to append the merge.

Because these are the only three kinds, a reader can tell how merge content relates to
its parents without re-running anything. `synthesize` is the mixture-of-agents case
(§12).

**Tree conflicts.** Tree merge is defined only for the same binary parent pair, over
the same Environment and one common-ancestor tree. The platform MUST resolve the tree
separately and record the outcome on the merge commit's `treeCheckpoint`. A merge with
more than two tree inputs is invalid rather than implementation-defined. This maps to
**C13-RUN-BINARY-TREE-MERGE**.
`policies.treeMerge` is a field of `PolicySet` (§9.2) alongside `tiers`, `approvals`, and
`placement` — one more declared policy, not a new artifact — naming three settings and
never picking silently:

- `ours` / `theirs` — take one side's tree wholesale (the resolution records which);
- `perPath` — take, per path, the side that changed it relative to the common ancestor;
  paths changed on **both** sides are conflicts and are surfaced, not guessed. No merge
  commit is appended while any conflict is unresolved. **The operator** is the
  authenticated Principal who invokes the `administer`-impact merge-resolution Operation
  for this Run's Scope — the term names who that Operation's caller is, not a second
  resolution path: there is exactly one mechanism, an `administer`-impact Operation, and
  "the operator" is how this document refers to whoever legitimately calls it. That
  Operation supplies an explicit side for every conflict; the final merge records those
  path resolutions. A platform that never merges over a shared tree (each branch owns a
  disjoint Environment, the Cognition read/write-split pattern) never encounters tree
  conflicts and MAY omit `policies.treeMerge`; one that omitted it and then merges two
  branches over one Environment rejects that merge, because no explicit side can be
  supplied. This maps to **C13-RUN-TREE-CONFLICT-EXPLICIT**.

![The commit graph: undo as selection](diagrams/undo-graph.svg)

```ts
interface RunCommit {
  readonly id: RunCommitId;
  readonly run: RunId;
  readonly branch: RunBranchId;
  readonly kind: "root" | "message" | "checkpoint" | "invocation" | "eventDelivery"
               | "result" | "merge" | "verdict" | "undo" | "migration" | "rewrite";
  readonly parents: readonly RunCommitId[];
  readonly pins: RunPins;
  readonly writer: CommitWriter;
  readonly subjectTurn?: TurnId;
  readonly content?: ContentRef;
  readonly selects?: RunCommitId;                 // undo/redo only
  readonly shadows?: readonly RunCommitId[];      // rewrite only (§5.2) — none when abandoned
  readonly requests?: readonly InvocationId[];    // message only — Invocations its content requests
  readonly treeCheckpoint?: ContentRef;           // §5.4 — associated tree snapshot, if any
  readonly resolution?: MergeResolution;          // merge only (§5.2.1)
  readonly treeResolution?: TreeMergeResolution;  // merge only (§5.2.1)
  readonly invocation?: InvocationId;                 // invocation only (§7.3)
  readonly receipt?: ReceiptId;                   // invocation or control effect
  readonly reservation?: RouteReservationId;      // eventDelivery only
  readonly migration?: { readonly from: RunPins; readonly to: RunPins }; // migration only
}

type CommitWriter =
  | { readonly kind: "root" }
  | { readonly kind: "turn"; readonly token: LeaseToken }
  | { readonly kind: "system"; readonly cause: SystemCause };

type SystemCause =
  | { readonly kind: "receipt"; readonly audit: AuditRecordId; readonly receipt: ReceiptId }
  | { readonly kind: "delivery"; readonly audit: AuditRecordId;
      readonly reservation: RouteReservationId }
  | { readonly kind: "control"; readonly audit: AuditRecordId; readonly receipt: ReceiptId };

type MergeResolution =
  | { readonly kind: "pick"; readonly parent: RunCommitId }
  | { readonly kind: "concat" }
  | { readonly kind: "synthesize"; readonly token: LeaseToken;
      readonly receipt: ReceiptId };

type TreeMergeResolution =
  | { readonly policy: "ours" | "theirs"; readonly side: RunCommitId;
      readonly base: ContentRef; readonly environment: EnvironmentId }
  | { readonly policy: "perPath"; readonly resolutions: readonly PathResolution[];
      readonly base: ContentRef; readonly environment: EnvironmentId };

// `base` and `environment` name the exact common-ancestor tree and the Environment the
// merge resolved over — the two facts "the same Environment and one common-ancestor
// tree" (below) requires a reader be able to check without re-deriving them.
interface PathResolution {
  readonly path: string;
  readonly side: RunCommitId;
}

```

Every SystemCause names exact evidence and a preexisting compatible AuditRecord. The
commit-kind matrix is closed:

| CommitWriter | Permitted kinds | Additional requirement |
| --- | --- | --- |
| `root` | `root` | atomic with Run creation |
| `turn(token)` | `message`, `checkpoint`, `result`, `verdict` | exact current LeaseToken; `subjectTurn = token.turn` |
| `system(receipt)` | `invocation` | exact Receipt for any outcome and matching Receipt audit |
| `system(delivery)` | `eventDelivery` | exact terminal RouteDelivery and matching delivery audit |
| `system(control)` | `merge`, `undo`, `migration`, `rewrite` | exact `administer` Receipt and matching audit, successful except an abandoned `rewrite` (§5.2) |

No other pair commits; a host MUST reject any CommitWriter and kind pair this matrix
does not name. Root, Turn-authored content, Receipt evidence, and delivery
evidence do not require a successful Invocation. Only control effects do, and only an
abandoned rewrite (§5.2) is excepted. A system writer MAY append Receipt or delivery
evidence after the originating Turn is fenced;
it gains no Turn authority. Every merge MUST be system-authored by its successful
matching control Receipt. A `synthesize` merge additionally MUST record a LeaseToken
and a successful `execute` Receipt whose PreparedInvocation binds that exact token and
content. These map to **C13-WRITER-MATRIX**, **C13-WRITER-POST-FENCE-EVIDENCE**,
**C13-WRITER-SYSTEM-MERGE**, and **C13-WRITER-SYNTHESIS**.

*Why selection instead of head-rewind:* an append-only graph means nothing is ever
lost, undo is itself undoable, ancestry queries stay simple, and two observers can
never disagree about history — they can only disagree about which commit is currently
selected, which is one field.

### 5.3 Turn: lease-fenced execution attempts

A **Turn** is one lease-fenced execution attempt inside a Run: input, status, lease,
branch, immutable TurnPlacementSnapshot, captured FacetSet, checkpoints, Invocations,
result.

```ts
interface LeaseToken {
  readonly turn: TurnId;
  readonly holder: PrincipalRef;
  readonly epoch: number;
}

abstract class TurnLease {
  abstract readonly turn: TurnId;                                     // exact, immutable
  abstract readonly holder: PrincipalRef | undefined;
  abstract readonly epoch: number;                                   // monotonic
  abstract readonly expiresAt: Date | undefined;
  abstract claim(holder: PrincipalRef, now: Date, expiresAt: Date): TurnLease;
  abstract renew(holder: PrincipalRef, epoch: number, now: Date, expiresAt: Date): TurnLease;
  abstract reclaim(holder: PrincipalRef, now: Date, expiresAt: Date): TurnLease;
  abstract fence(): TurnLease;                                       // epoch += 1, holder cleared
}
```

A Turn starts `queued` with an unheld exact-Turn lease at epoch 0. The only lifecycle
transitions are those in the table below; a Turn MUST NOT take any other, and the
complete table maps to **C13-TURN-LIFECYCLE**:

| From | Operation | To | Lease rule |
| --- | --- | --- | --- |
| `queued` | claim | `running` | set holder and expiry; epoch + 1 |
| `running` | renew | `running` | same holder and epoch, unexpired lease, later expiry |
| `running` with expired lease | reclaim | `running` | replace holder and expiry; epoch + 1 |
| `running` | suspend | `suspended` | persist checkpoint, then fence; epoch + 1 |
| `suspended` | claim | `running` | set holder and expiry; epoch + 1 |
| `running` | succeed | `succeeded` | commit result, then fence; epoch + 1 |
| `running` | fail | `failed` | commit result, then fence; epoch + 1 |
| `running` | cancel | `cancelled` | fence; epoch + 1 |
| `queued` | cancel | `cancelled` | clear holder; epoch + 1 |
| `suspended` | cancel | `cancelled` | remain unheld; epoch + 1 |
| `queued` sibling | system force-cancel during terminalization | `cancelled` | exact administer control evidence; fence epoch + 1; token-scoped cancellation inbox/audit |
| `running` sibling | system force-cancel during terminalization | `cancelled` | exact administer control evidence; fence epoch + 1; token-scoped cancellation inbox/audit |
| `suspended` sibling | system force-cancel during terminalization | `cancelled` | exact administer control evidence; fence epoch + 1; token-scoped cancellation inbox/audit |

Terminal Turns MUST NOT transition. A lease never changes its `turn` and MUST NOT
authorize a write for another Turn. Every executor-authored RunCommit, Invocation
intent, EffectAttempt, child-Run spawn, callback, checkpoint, and terminal result MUST
present that exact Turn id and the current lease epoch; mismatch, expiry, or stale
epoch rejects it. A system writer MAY append only the evidence and control kinds
allowed by the §5.2 CommitWriter matrix. These map to **C13-TURN-EXACT-LEASE** and
**C13-TURN-EXECUTOR-WRITER**.

Every claim, renew, or reclaim requires `expiresAt > now` and MUST be rejected without
it; reclaim additionally requires the recorded expiry to be at or before `now`. This
maps to **C13-TURN-LEASE-EXPIRY**.

A Turn's FacetSet (§4.1) is exactly the `facet` refs of its immutable
TurnPlacementSnapshot's `placements`, in canonical order, so a Turn captures its
composition view in the same transition that captures its placements (§5.2) and the view
inherits that record's immutability rather than needing a record of its own. Membership
does not change for the Turn's lifetime: an install or a withdrawal (§4.1) committed after
capture is composed by later Turns and never by this one. The executor seam (§5.6) offers
a Turn no second composition view — every membership question a Turn asks is answered from
its captured set and never from the Scope's current install records — so a Turn cannot
observe a membership it did not capture. Capture fixes membership and nothing else: a
captured member is a FacetRef, so capture neither produces a ResolvedFacet nor extends
one, every use of a member independently re-resolves and re-authorizes under §3.4's
resolution-lifetime rule, and a Grant revoked, a Binding retired, or a path epoch advanced
mid-Turn severs that member's capability at its next use while the set the Turn composes
is unchanged. Membership stability is therefore not authority stability, and neither is
tradable for the other: a Turn holds a stable answer to which Facets it composes and no
standing answer at all to whether it may still call one. A Turn whose captured member is
withdrawn observes a typed unavailability at its next use of that member, never a silently
smaller set, and a ref the captured set omits stays unavailable to the Turn however the
Scope's composition changes afterward. This maps to **C13-TURN-FACET-SET-STABLE**.

For running success, failure, or cancellation, the terminal result commit is validated
with the current LeaseToken and the fence is applied in the same transition, with the
result logically before the fence. Queued and suspended cancellation produces no Turn
result commit unless Run terminalization records it as a captured system obligation.

![Turn lease lifecycle](diagrams/turn-lease.svg)

The lease is deliberately application-visible: your code can hand the epoch to an
external system and ask it to check, and that check is the only kind of fencing that
still works across a network partition.

### 5.4 Checkpoints

Two checkpoint kinds are distinct and MUST NOT be conflated: **run checkpoints**
(conversation and executor state, recorded as RunCommits) and **tree checkpoints**
(filesystem state of an Environment, content-addressed snapshots). Undoing a
conversation and undoing files are separate operations — a RunCommit MAY carry
`treeCheckpoint` (§5.2) naming the tree snapshot current at that commit, which is what
makes *coordinated* undo expressible as two explicit steps, never one implicit one. This
maps to **C13-RUN-CHECKPOINT-KINDS**.

### 5.5 Cache lineage

A Turn may carry an advisory `cacheLineage` hint identifying the Turn and prompt
prefix it descends from, so executors can preserve provider-side prefix caches across
forked or parallel attempts. The lineage it names is already derivable: the prompt prefix
is reconstructable from committed records (§5.6), so the hint is a precomputed shortcut
past that reconstruction and carries nothing the log lacks. That is what makes it purely
advisory with no correctness semantics — a lost, stale, or forged hint costs a cache miss
and changes no outcome. Systems that exploit prefix-cache sharing across forks have
measured roughly a quarter of inference cost saved, which is what earns this a dedicated
field.

### 5.6 The executor seam

```ts
abstract class TurnExecutor {
  abstract execute(turn: TurnContext): Promise<TurnOutcome>;
  // TurnContext: resolved facets, operation catalog, prompt assembly and its
  // records-only reconstruction, inbox, lease commit handle, checkpoint handle,
  // tiered invocation gateway (§7.2), cancellation signal
}
```

Existing harnesses — the Claude Agent SDK, Pydantic AI, the Vercel AI SDK, bespoke
loops — are hosted behind this seam. Prompt assembly derives from platform rules,
Agent instructions, Workspace/Run context, the branch's **effective state** (§5.2 —
not the raw head, which may be an undo marker), `prompt` contributions, and operation
help, and is interceptable at `prompt.assemble`.

Nothing the model observes exists only in executor memory. For every model call, the
complete request as the model observed it — the assembled prompt sections in their final
order, the operation catalog as offered, and every inbox Event admitted before the call —
MUST be reconstructable from durable records the Turn has already committed: RunCommits,
Events, and the content those records name. Reconstructability is an obligation on this
seam rather than a property asserted of the records: a conforming host exposes a
reconstruction that takes a Turn's committed records alone and yields the exact request the
model received, and the model call issues that reconstruction's output rather than a
separately assembled value the reconstruction is expected to approximate. Content MAY be
recorded by reference (`ContentRef`, §1.4) rather than inline, so reconstructability costs a
digest rather than a second copy of the prompt. An interceptor rewrite at `prompt.assemble`
records the result it produced, not merely that it ran. Model-visible content that
originates in ambient executor state and leaves no durable trace is a conformance
violation. Naming the reconstruction is what makes the rule testable — replaying it over
committed records and comparing byte for byte against what was sent separates compliance
from records that merely look sufficient — and what makes fork, resume, replay, and audit
consequences of one implementation instead of four features each carrying its own partial
copy of the model input. This maps to **C13-TURN-MODEL-INPUT-RECONSTRUCTABLE**.

Committing those records precedes the call rather than following it. The reconstruction's
inputs — the RunCommits carrying the assembled sections and the catalog as offered, and the
record naming every inbox Event admitted before the call — MUST be durable before the
request is dispatched, and the seam's lease commit handle is what makes them so: the
dispatch waits on that commit. A host that assembles, dispatches, and then commits
satisfies the rule at rest while violating it throughout the interval between the two,
because a crash there leaves a request the model has already read and no committed record
describes, and nothing repairs it afterward — the only copy of that request was the
executor memory the crash discarded. §7.4 already orders immutable write-ahead evidence
before an item crosses the effect boundary, and this is that discipline for the model call.
The ordering is fail-closed: a commit the Turn's lease rejects (§5.3), a store that is
unavailable, or a commit whose outcome is unknown prevents dispatch, and the Turn either
reaches durability on a further attempt at that same commit or fails without having called
the model. A durability failure is never grounds to proceed, because the commit exists to
make the call accountable and a call that outruns its own record is what this rule forbids
rather than a tolerable degradation of it. The unknown outcome is the decisive case: a host
that dispatches on an indeterminate commit chooses the one behavior that produces an
unrecorded model call at exactly the moment it cannot tell whether it has. This maps to
**C13-TURN-MODEL-INPUT-DURABLE-BEFORE-DISPATCH**.

The reconstructability rule binds records that exist, and retention is not eternal. Content
a request names is retained by the records naming it (§8.2), an Event is immutable rather
than undeletable (§6.1), and Tenant-level retention policy — export, legal deletion, Tenant
closure — legitimately ends retention for content a committed request depends on. A
reconstruction that finds a named Event or `ContentRef` no longer retained MUST fail with a
typed error naming what is missing, and MUST NOT assemble a shorter prefix, a partial
request, or a best-effort approximation. Losing content is legitimate; losing it silently
is not. A reconstruction that quietly yields a different request is worse than one that
refuses, because the byte-compare that makes reconstructability testable would then compare
two wrong values and pass. This maps to **C13-TURN-MODEL-INPUT-RETENTION-LOSS**.

A rewrite (§5.2) changes what the next model call sends without changing what an earlier one
reconstructs to, and the two rules compose without a further record because of where a
rewrite lands. A reconstruction derives the effective transcript from the exact commit its
call read, and a rewrite appended afterwards is a descendant of that commit and never an
ancestor, so it cannot enter that derivation: the transcript is monotone in the commit it is
derived from, and reduction is forward-only. A rewrite also releases nothing an earlier
request named, because a shadowed RunCommit is still append-only and undeletable and still
retains the content it names (§8.2); shadowing supersedes without releasing, so it never
produces the missing-content failure C13-TURN-MODEL-INPUT-RETENTION-LOSS names, which stays
what it was — Tenant retention policy ending custody, not history being rewritten. Prompt
assembly accordingly derives from the branch's effective transcript rather than from the
effective state commit alone, and a reconstruction reads every rewrite that is an ancestor
of its base commit whichever Turn appended it. This maps to
**C13-TURN-TRANSCRIPT-RECONSTRUCTION**.

A model is regularly shown less of a result than the record holds. An Operation's result is
recorded whole — §7.4 sets no size bound on a result and names no failure kind for one too
large — while the context a model reads is finite, so a host abridges what it puts in front
of the model. Abridging is legitimate; presenting an abridged value as a whole one is not. A
request that carries less of a result than the record holds MUST carry that fact alongside
it, with the withheld amount stated exactly, or stated as unknown when the host bounded a
stream it never read to the end, and the abridged form itself is what the request records —
inline or by a `ContentRef` that resolves to it, never by a digest of it, because a digest
proves what a value was while only a reference retrieves it (§1.4).
Recording the whole result together with a flag that it was shortened does not satisfy
reconstructability, because the model observed the abridged bytes and a reconstruction from
such a record rebuilds a longer request than the one that was sent. Recording the
abridgement as a derivation over the whole result's `ContentRef` fails for a second reason:
ending retention of that content leaves the shown form unrebuildable and invites a
re-derivation from what survives, which is the silent-different-request case
C13-TURN-MODEL-INPUT-RETENTION-LOSS forbids. The omission fact accompanies the shown bytes
and never stands in for
them. That fact is also distinct from the result's own completeness: a `list` page, a
byte-ranged `read`, and a `partiallySucceeded` batch (§7.4) each report that the source
covered less than was asked, and a host MUST NOT record either fact as the other or fold one
into the other's field. The two support opposite inferences — content withheld under a bound
exists and is retrievable, an incomplete source has nothing further to give — so conflating
them makes a model retry a source that holds nothing more, or abandon one that does. Keeping
them apart is what lets a reconstruction rebuild a request without re-deriving the budget
decision that shaped it, and it is why an abridged result recorded as a whole one misleads
even when the reconstruction is byte-exact: a byte-compare establishes that a request was
rebuilt, never that it was true. This maps to **C13-TURN-MODEL-INPUT-ABRIDGED**.

Mid-turn input uses `turn.deliverEvent`: a lease-fenced operation appending an Event
to the running Turn's inbox; hosts MAY implement delivery as "the durable log is the
queue" — re-read the inbox each step. **Cancellation** is the reserved inbox Event
`turn.cancel`: fencing a Turn (undo, takeover, timeout) delivers it, and a conforming
executor observes the cancellation signal between steps and stops committing. This maps
to **C13-TURN-CANCEL-INBOX**.

An executor MAY hand the model a handle instead of a result: a mediated Invocation's
tool position then returns its admission identity — the InvocationId, or the child
RunRef for a `delegate`-impact spawn — and the outcome arrives later as an ordinary
Event, delivered mid-turn through `turn.deliverEvent` or read from the inbox by a
later Turn if this one ends first. Nothing about admission changes: the pipeline runs
unaltered, the Receipt and audit chain attach to the identity the handle names, and a
spawn's `delegate` Receipt carries the child RunRef, never the child's result. This
is the non-blocking shape — a parent spawns, ends its Turn, and reads the answer as
history instead of holding its context open to wait. This maps to
**C13-TURN-ADMISSION-HANDLE**.

The Turn lifecycle above is closed. There is no normative `retryTurn` transition, a failed
or cancelled Turn is never resurrected, and ordinary admission of another Turn creates no
retry linkage or inherited authority. This maps to **C13-TURN-NO-RETRY**.

The runtime MUST contain no Turn-retry operation that can recreate a terminal Turn. This
maps to **C13-TURN-NO-RETRY-RUNTIME**.

The command protocol MUST contain no Turn-retry command family. This maps to
**C13-TURN-NO-RETRY-PROTOCOL**.

The supported package surface MUST expose no Turn-retry symbol. This maps to
**C13-TURN-NO-RETRY-EXPORT**.

The durable record and migration registries MUST contain no Turn-retry record or upcast. A
later integration that finds such a pre-public extension deletes it rather than adapting
it. This maps to **C13-TURN-NO-RETRY-RECORD**.

---

## 6. Interaction (L3)

### 6.1 Events, provenance, ingress

An **Event** is an immutable occurrence record: scope, source (Facet or Actor),
category, payload reference and digest, idempotency key, correlation and causation,
**provenance**, derived **TrustTier**, and visibility policy. A webhook, a schedule
firing, a chat message, a button press, and a command invocation are all Events: one
input model, one routing mechanism, and one audit trail for everything that enters the
system.

**Trust tiers MUST be host-derived, never facet-asserted**, which maps to
**C13-TRUST-HOST-DERIVED**. A Facet supplies raw
provenance — authenticated identity, channel, group, transport verification result —
and the host derives the tier from that provenance and the Blueprint's trust-tier
policy:

- `owner` — the authenticated owning Principal of the scope;
- `authenticated` — a verified non-owner principal;
- `external` — unauthenticated or third-party origin;
- `self` — emitted by a Turn executor under a valid lease. Assignable only by the
  host for lease-fenced emissions.

TrustTier is categorical, not ordered. Consumers MUST declare an explicit accepted set;
there is no minimum-tier comparison. This maps to **C13-SUBSCRIPTION-ACCEPTED-TIERS**.

An Event whose tier was set by a non-host source MUST be rejected. If a channel adapter
could stamp its own trust tier, a compromised adapter could mark an attacker's message
as `owner` and defeat every policy keyed on the tier. This maps to
**C13-TRUST-ASSERTION-REJECTION**.

**Ingress.** External input enters through `ingress` contributions:

```ts
interface IngressDeclaration {
  readonly path: string;                       // or transport binding
  readonly verification: { scheme: "hmac" | "signature" | "oauth" | "mtls"; secret: SecretRef };
  readonly provenance: ProvenanceMapping;      // verified identity → provenance fields
}
```

The host exposes declared endpoints, verifies per `verification`, and mints Events
with derived provenance; unverified requests MUST NOT mint Events. This maps to
**C13-TRUST-VERIFIED-INGRESS**.

The standard source actions enter through ordinary mediated host Operations and the
closed Receipt-to-Event causal edge; they do not create a WriteRecord-to-Event edge or
another audit root. The exact mapping is:

| Source Event | Host Operation | Required source outcome |
| --- | --- | --- |
| `task.actionSubmitted` | `host.task.submitAction` (`mutate`) | successful AttemptReceipt |
| `command.invoked` | `host.command.submit` (`mutate`) | successful AttemptReceipt |
| verified ingress Event | `host.ingress.accept` (`mutate`) | successful AttemptReceipt after transport verification |
| scheduler Event | `host.schedule.fire` (`mutate`) | successful AttemptReceipt for the exact `(subscription, fireTime)` key |

The successful Receipt's AuditRecord causes the Event AuditRecord, after which routing
continues `Event → RouteReserved`. A denied, cancelled, failed, indeterminate, or
unverified source action emits no source Event. `command.completed` is similarly caused
by the target Operation's terminal Receipt. This maps to
**C13-PROFILE-SOURCE-EVENT-CAUSALITY**.

**Ownership.** An Event is owned by the Actor that accepts it (§8.4). Appending and
routing are transactional within that owning Actor; routing over Events owned by a
different Actor is an asynchronous, at-least-once, idempotency-keyed projection
(§10.1).

### 6.2 Subscription

A **Subscription** is a durable route from matching Events to an Operation:

```ts
type DedupePolicy = "none" | "event" | "causation" | "payload";

interface Subscription {
  readonly id: SubscriptionId;
  readonly source: EventPattern;             // which Events match
  readonly target: OperationRef;
  readonly mapping: PayloadMapping;          // event payload → operation input
  readonly dedupe: DedupePolicy;             // "none" | "event" | "causation" | "payload"
  readonly authority: AuthoritySource;
}

type AuthoritySource =
  | { readonly kind: "initiator"; readonly binding: BindingName }
  | { readonly kind: "delegated"; readonly binding: BindingName };

type TenantRelation =
  | { readonly kind: "same"; readonly tenant: TenantId }
  | { readonly kind: "cross"; readonly source: TenantId; readonly target: TenantId;
      readonly authority: BindingName };

interface RouteReservation {
  readonly id: RouteReservationId;
  readonly invocation: InvocationId;          // stable across every delivery retry
  readonly event: EventId;
  readonly sourceAuditCause: AuditRecordId;
  readonly sourceActor: ActorRef;
  readonly targetActor: ActorRef;
  readonly tenants: TenantRelation;
  readonly subscription: SubscriptionId;
  readonly dedupeKey: string;
  readonly operation: OperationRef;
  readonly authority: AuthoritySource;
  readonly projection: RouteProjectionId;
  readonly projectionRef: ContentRef;
  readonly projectionDigest: Digest;
  readonly trust: TrustTier;
  readonly initiator?: PrincipalRef;
}

interface RouteProjection {
  readonly id: RouteProjectionId;
  readonly reservation: RouteReservationId;
  readonly content: ContentRef;
  readonly digest: Digest;
  readonly authenticationDigest?: Digest;   // present exactly when authenticated
}

interface RouteDelivery {
  readonly reservation: RouteReservationId;
  readonly outcome: "delivered" | "rejected";
  readonly targetAudit: AuditRecordId;
  readonly reason?: string;                  // required exactly when rejected
}

// An EventPattern matches on kind and source, each a literal or a "*"-terminated
// prefix wildcard, and an explicit nonempty accepted-tier set. All fields must match.
interface EventPattern {
  readonly kind: string;                     // "task.*" matches "task.statusChanged"
  readonly source?: string;                  // Facet/Actor id, prefix-wildcarded
  readonly acceptedTrust: readonly [TrustTier, ...TrustTier[]]; // unique; no tier ordering
}

// A PayloadMapping (and the FieldMapping used by Commands, §4.3) is an ordered list of
// moves from source JSON-pointer paths into target paths, with optional literals.
// It is pure data — no code — so it is validated at install and inspectable.
type PayloadMapping = readonly FieldMove[];
interface FieldMove {
  readonly to: string;                       // JSON Pointer into the operation input
  readonly from?: string;                    // JSON Pointer into the event payload
  readonly literal?: FacetData;              // used instead of `from` for a constant
}
```

Routing is at-least-once with deduplication on the subscription's dedupe key: `event`
dedupes on the Event id, `causation` on its cause, `payload` on its payload digest, and
`none` assigns each delivery a distinct key. Before delivery, the Event-owning source
Actor MUST authenticate the Event and mapping, derive trust, validate it is in
`acceptedTrust`, map the payload, and append the authoritative **RouteReservation**.
The reservation's projection and digest MUST be immutable; the target never remaps
source data or accepts an unauthenticated projection. These map to
**C13-ROUTE-SOURCE-OWNED** and **C13-ROUTE-PROJECTION-DIGEST**.

`initiator` uses the authenticated initiating Principal recorded by the source Actor in
the reservation through exactly its named Binding; an Event without one cannot use that
source. The target copies that Principal into InvocationAuthority and cannot substitute
another principal. The complete PrincipalRef, including tenant, MUST exact-match the
source Event, RouteReservation tenant relation, PreparedInvocation authority, optional
LeaseToken holder, and any AuthorityPermit; matching `PrincipalId` values in different
Tenants are different principals.
`delegated` uses the named Binding independently of the initiator. A same-tenant reservation prohibits cross-tenant authority. A cross-tenant
reservation requires the `TenantRelation.cross.authority` Binding in addition to the
Subscription's AuthoritySource; absence or tenant mismatch denies delivery. These map to
**C13-SUBSCRIPTION-AUTHORITY** and **C13-ROUTE-CROSS-TENANT-BINDING**.

For a deduplicating policy, `(subscription, dedupeKey)` identifies one reservation and
one stable InvocationId; redelivery reuses both and cannot prepare another intent.
A reservation has at most one terminal RouteDelivery — admission writes it, so a
reservation the target has not admitted has none — and it is written once: a redelivery
that finds it returns it rather than appending another. `sourceAuditCause` MUST
be the preexisting source-Actor Event AuditRecord for that reservation's `event` field and
causes the source-local reservation audit entry. This maps to **C13-ROUTE-DELIVERY-ONCE**.
The source-owned reservation is the only cross-Actor causal
bridge. Its authenticated projection admits a cause-free, target-local
`routeProjected` bridge root; that root is not caused by any source AuditRecord.
Target-local delivery and preparation cite the bridge root. A scheduled automation is a Subscription from a
scheduler Event (idempotency key derived from `(subscription, fireTime)`); a webhook
automation is a Subscription from a verified ingress Event. Example:
`{ source: { kind: "schedule.daily-report", acceptedTrust: ["self"] },
target: "report.generate", dedupe: "event",
authority: { kind: "delegated", binding: "daily-report" } }`.

### 6.3 Surface, View, ViewDelta

A **Surface** is a stable UI contribution from a Facet; a **View** is one rendered
snapshot of it.

```ts
interface View {
  readonly surface: SurfaceId;
  readonly revision: Revision;               // replay is keyed on this (§10.3)
  readonly body: ViewBody;                   // JSON data only — no live handles
  readonly actions: readonly ActionDescriptor[];
  readonly cursor: EventCursor;              // opaque resume position in the Event log
  readonly intentDigest?: Digest;            // present exactly on a decision View (§7.3)
  readonly marks?: readonly ViewMark[];      // provenance of values the host did not originate
  readonly terminal?: true;                  // present exactly on a retired Surface's last View
}

// A ViewMark attributes one sub-value of `body` to the TrustTier of the Event or
// Operation input it came from (§6.1). `path` uses the same JSON Pointer vocabulary
// FieldMapping and PayloadMapping already use (§6.2) — no new pointer syntax.
interface ViewMark {
  readonly path: string;                     // JSON Pointer into `body`
  readonly tier: TrustTier;
}

// ViewBody is arbitrary JSON: the rendered, data-only snapshot a client displays.
// It contains ContentRefs and SurfaceIds, never live Facets, stubs, or credentials.
type ViewBody = FacetData;

// An ActionDescriptor declares a user action the View offers and the Event it emits
// when invoked; the platform routes that Event to an Operation via a Subscription.
interface ActionDescriptor {
  readonly id: string;                       // stable within the Surface
  readonly label: string;                    // localizable (string or i18n key)
  readonly emits: EventKind;                 // the Event kind this action produces
  readonly arguments?: JsonSchema;           // shape of the action's payload
}

// EventKind is the Event's `kind` string (§6.1); `EventPattern.kind` matches it.

// An EventCursor is an opaque, codec-stable position in the owning Actor's Event log.
// A reconnecting client presents its last cursor to resume ViewDelta replay (§10.3).
```

A View MUST carry no live Facets, stubs, credentials, or hidden state — refs only.
Surfaces stream via **ViewDelta** events: RFC 6902 JSON Patches against a View
revision (compatible with AG-UI's `STATE_DELTA` convention), so clients update
without re-snapshotting. Surface actions emit Events; Subscriptions route them to
Operations. Aggregating surfaces — dashboards — compose slot-contributed child Views
per §4.2. Token-level model-output streaming is an executor and transport concern
(§5.6), not Events. This maps to **C13-VIEW-NO-LIVE-STATE**.

A retired Surface terminates its stream. Withdrawing a Facet retires its Surfaces (§4.1);
a retired Surface emits one final ViewDelta — the patch that adds `terminal` to its View —
and then no further revision, so the last revision of a retired Surface is discriminated
by that field's presence exactly as a decision View is by `intentDigest`, and a host MUST
NOT emit a revision after a View's terminal one. A client presenting an `EventCursor` for a
retired Surface receives that terminal revision rather than a resumable stream or an error,
and an aggregating Surface (§4.2) drops the retired child's entry at its next revision
rather than composing a stale snapshot. Retirement costs a client nothing beyond the
revision it already tracks, because a View is data and holds no live handle: there is no
connection to break, no stub to invalidate, and no acquired state to release, so the
terminal revision is an ordinary revision that happens to be the last, and a retired
Surface's last View stays exactly as readable as any earlier one. Terminating a stream is
expressible as one more revision only because the no-live-state rule already holds. This
maps to **C13-VIEW-WITHDRAWAL-TERMINAL**.

A View that presents an intent for a human decision carries the provenance of what it
shows. A **decision View** is exactly a View whose `intentDigest` field is present — the
field's presence is the discriminator, naming the exact intent (§7.3) the decision
authorizes; an ordinary View omits it. Every body value the host did not originate MUST be
marked with the TrustTier of the Event or Operation input it came from (§6.1) in that
View's `marks` list. A Surface MUST render a marked value as data and never as **platform
voice** — platform voice is any rendered position a viewer would attribute to the platform
itself rather than to the marked value's own source: unquoted body copy, a headline, a
button label synthesized from the value. Rendering as data means a position and treatment —
a quoted or clearly labeled field, never host-authored prose — that a reasonable viewer
reads as showing someone else's input, not the platform speaking. Without this the last
step of the chain — a person reading rendered text — is the one step decided on
unattributed input. This maps to **C13-VIEW-APPROVAL-PROVENANCE**.

---

## 7. Mediation (L4)

### 7.1 Impact taxonomy

The six impacts are defined in §1.4. The **trust boundary** encloses the protection
domains (§1.5) the Tenant controls. A request crosses it when its destination is not one
of them: another Tenant, a third party, or any endpoint reached over a network the
platform does not own.

Boundary rule: an operation whose request crosses the trust boundary is `externalSend`
regardless of data direction, and reading the response is `observe`. A web fetch is
`externalSend`; listing its cached result is `observe`. The host derives this from the
**seam** the call leaves through — never from what the callee declares about itself — and a
seam is fixed by whoever controls the destination, never by the destination itself.
For an Operation whose destination is the platform's own first-party code, `bundled`
placement (§9.2) already is that control: a Blueprint that trusts a Package enough to run
it in-process has already trusted every claim in its manifest, impact included, so the
manifest's declared impact stands as the seam. For an Operation whose destination is
externally configurable — an integration reaching an endpoint the Tenant chose — the seam
is the Tenant's own install-time configuration (the `configSchema`-validated vocabulary
§4.1 already has, not a new one): a boundary fact the Blueprint or Package config records
when the integration is installed, never a value the configured endpoint returns at call
time. A declared impact is a claim by the party whose reach is in question, so a host that
accepted one uncritically would let any remote name its own enforcement tier — such a claim
MAY raise the §7.2 floor the seam derives, never lower it: it is refused whenever it would
admit `direct` under any condition where the derived impact requires `mediated`. §11's MCP
profile is one instance of this rule, not an exception to it: its `remote` install
configuration is the seam, and a tool's own impact annotation may only raise the floor
`remote` derives. This maps to **C13-FACET-IMPACT-BOUNDARY**.

### 7.2 Enforcement tiers

Every protected call is an **Invocation**; enforcement is tiered. Workspace policy maps an
Operation's `Impact` to an `EnforcementTier`. Impact is the key because it is the class the
policy is about; the facet and the Operation are derivable from the call itself, and a
policy keyed on them would be an instance list rather than a rule. Event trust tier decides
whether an Event may invoke a Command at all (§6.1), which is an admission question and not
a tiering one.

- **mediated** — the durable pipeline: resolve initiator or delegated-Binding authority → durably record intent →
  reserve the Run obligation when Run-associated → evaluate policy → Approval when
  required (§7.3) → establish the exact item claim → perform the final Actor-local
  authority admission or issue the cross-Actor §10.3 permit → pre-effect Receipt
  **or** EffectAttempt → invoke under stable operation identity →
  attempted Receipt → AuditRecord → Event.
- **direct** — an in-process call. Authority, exact current Turn lease, delivered
  watermark, PathEpochEvidence, and immutable §3.4 deadline are checked in memory; no durable
  writes occur on the call path; telemetry MAY be sampled. A `direct` call MUST resolve a
  facet `bundled` in the Actor that owns the Turn lease; a
  provider- or dynamic-mode facet is never `direct`, because its authority check would
  cross an isolate boundary. This co-location requirement maps to
  **C13-POLICY-DIRECT-COLOCATION**.

Enforcement is a floor, not a bidirectional override. The floor is: `observe` → direct;
on a Turn-owned Session (§4.5), `execute` and `mutate` whose target is that Session's
own filesystem → direct; every other `execute` and `mutate`, plus
`externalSend`, `delegate`, and `administer` → mediated. Policy MAY raise a direct floor
to mediated, and MAY add approval, which raises it too: an approval has nowhere to be
recorded on the direct path. It MUST NOT lower a mediated floor or remove an approval
required by a profile, Operation, Package, or ancestor policy. Three further conditions
raise direct to mediated: lack of bundled co-location; an applicable `operation.before`
or `operation.after` interceptor, whose rewrite evidence (§4.4 rule 3) has no direct
channel to be recorded through; and the absence of a configured
`maxDirectRevocationWindowMs`, without which §3.4 rule 6 can bound no revocation window.
An interceptor contributed over an `observe` operation therefore moves that read onto the
mediated path, and a host SHOULD surface that consequence at contribution time rather than
leave it to be discovered as latency. These tightenings are monotone.
A write inside a Turn-owned Session crosses no seam (§7.1) and acquires no authority, so it
can neither exfiltrate nor escalate, and the durable evidence for that filesystem is the
tree checkpoint the writes produce (§5.4) rather than a receipt per write — which is the
digest acceptance criteria and merges consume anyway. `mutate` against anything else — a
platform record, another facet, a shared or longer-lived Session — keeps its mediated
floor, and so does every `externalSend`, `delegate`, and `administer`. The two
prohibitions this floor states map to **C13-POLICY-MEDIATION-FLOOR** and
**C13-POLICY-APPROVAL-FLOOR**.

Every mediated effect, including an internal mutation or execution, uses the one final
authority-admission linearization point in §3.4 rule 7. Actor-local admission performs
the comparison in the attempt-admission transaction. Cross-Actor admission performs it
when the Tenant Actor issues the exact-claim permit; target consumption validates local
claim, fence, reservation epoch, watermark, single use, and expiry but does not reopen
the Grant decision. This rule is not limited to external sends and maps to
**C13-POLICY-EPOCH-RECHECK**.

![Tiers and the approval continuation](diagrams/mediation.svg)

### 7.3 PreparedInvocation and Approval

Preparation freezes the whole effect intent before policy or approval:

```ts
interface PreparedInvocationHeader {
  readonly id: InvocationId;
  readonly operation: OperationRef;
  readonly impact: Impact;
  readonly domain: ProtectionDomain;
  readonly target: FacetRef;
  readonly actor: ActorRef;
  readonly authority: InvocationAuthority;
  readonly lease?: LeaseToken;
  readonly placement: PlacementPin;
  readonly pathEpochs: PathEpochEvidence;
  readonly route?: RouteReservationId;
  readonly projectionDigest?: Digest;        // required exactly when route is present
  readonly auditCause: AuditRecordId;
  readonly requestKey: OperationRequestKey;
  readonly idempotencySeed: string;
}

type InvocationAuthority =
  | { readonly kind: "initiator"; readonly principal: PrincipalRef;
      readonly binding: BindingName }
  | { readonly kind: "delegated"; readonly principal: PrincipalRef;
      readonly binding: BindingName };

interface OperationRequestKey {
  readonly caller: CommandCaller;
  readonly key: string;
}

interface InterceptorTrace {
  readonly interceptor: InterceptorId;
  readonly before: Digest;
  readonly after: Digest;
}

interface InterceptorTransformation {
  readonly interceptor: InterceptorId;
  readonly input: FacetData;
  readonly output: FacetData;
  readonly trace: InterceptorTrace;
}

interface ReplayItem {
  readonly itemIndex: number;
  readonly rawPayloadIdentity: Digest;
  readonly before: readonly InterceptorTransformation[];
  readonly preparedArguments: FacetData;
  readonly after?: readonly InterceptorTransformation[];
  readonly presentation?: FacetData;
}

interface MediatedReplayRecord {
  readonly requestKey: OperationRequestKey;
  readonly target: FacetRef;
  readonly operation: OperationRef;
  readonly package: PackagePin;
  readonly lease?: LeaseToken;
  readonly route?: RouteReservationId;
  readonly invocation: InvocationId;
  readonly items: readonly [ReplayItem, ...ReplayItem[]];
}

interface PreparedItem {
  readonly arguments: FacetData;
  readonly idempotencyKey: string;
}

type PreparedPayload =
  | { readonly kind: "single"; readonly item: PreparedItem }
  | { readonly kind: "batch"; readonly items: readonly [PreparedItem, ...PreparedItem[]] };

interface PreparedInvocation {
  readonly header: PreparedInvocationHeader;
  readonly payload: PreparedPayload;
  readonly intentDigest: Digest;
}

interface InvocationContinuation {
  readonly invocation: InvocationId;
  readonly intentDigest: Digest;
  readonly approval: ApprovalId;
  readonly firstAttempt: EffectAttemptId;
  readonly firstItemIndex: number;
  readonly firstOrdinal: number;
  readonly firstClaim: ItemClaimId;
  readonly firstClaimOwner: ItemClaimOwner;
  readonly firstItemKey: string;
  readonly admittedAt: Date;
}
```

A PreparedInvocation MUST have exactly one shared header. A batch is nonempty and
ordered; homogeneity is structural because operation, impact, target, authority,
optional exact LeaseToken, and evidence occur only in that header. Every item MUST
validate against the shared Operation input schema. A single is not encoded as a
one-item batch, item order is part of identity, and a batch is not atomic. These map to
**C13-PREPARED-SHARED-HEADER**, **C13-PREPARED-OPTIONAL-LEASE**, and
**C13-PREPARED-PAYLOAD-SHAPE**.

The host MUST derive, never accept, each item key from the complete tuple
`("agent-core.item.v1", structuralDigest(completeSharedHeaderIdentity), payloadShape,
itemIndex, structuralDigest(arguments), header.idempotencySeed)`. The shared-header
identity commits every header field, not merely InvocationId; payload shape is `single`
or `batch(itemCount)`. The derivation is domain-separated and collision resistant;
index is zero for a single. `intentDigest` MUST cover the canonical structural
encoding of the complete header and payload, including shape, order, exact optional
LeaseToken, authority, evidence, arguments, and every derived key. Invocation identity
therefore explicitly binds both InvocationId and exact lease epoch. It is not byte
concatenation and omits no field. Format, derivation, and digest algorithm are
codec-versioned (§8.3). These map to **C13-PREPARED-ITEM-KEYS** and
**C13-PREPARED-WHOLE-DIGEST**.

Before any mutating interceptor runs, the host atomically looks up the
`MediatedReplayRecord` by authenticated caller plus `OperationRequestKey`. A miss
reserves that key together with the canonical raw structural payload identity, target
Facet/Operation/Package pin, exact optional lease, and exact optional route. A hit with
any changed bound field rejects before interceptors. A matching hit reuses the persisted
per-item `before` transformations and prepared arguments; after completion it also
reuses each item's persisted `after` transformations and presentation. `items` is the
exact payload length and order, every `itemIndex` equals its position, each transformation
chain is ordered and nested (`next.input = previous.output`), and an after chain remains
associated with the output of that same item. Batch replay cannot reorder, merge, or
substitute item traces or presentations. The record is completed atomically as each
phase becomes durable, so process death cannot cause either interceptor phase to rerun.
`direct` Invocations create no durable replay record or trace. These rules map to
**C13-PREPARED-REPLAY-IDENTITY**, **C13-PREPARED-REPLAY-PRE**, and
**C13-PREPARED-REPLAY-POST**.

A routed preparation MUST use its RouteReservation's stable InvocationId, authority,
projection digest, target Actor/domain, and audit bridge. `route` and `projectionDigest`
are either both absent or both present; when present, the digest MUST equal the
reservation's authenticated projection digest and `auditCause` MUST be the target
Actor's `routeProjected` AuditRecord for that reservation. Initiator authority MUST name
exactly the authenticated Principal owned by the source reservation. This maps to
**C13-PREPARED-ROUTED-PROJECTION**.

A local preparation has neither `route` nor `projectionDigest`, and allocates one stable
InvocationId. The host also assigns the immutable idempotency seed. If `lease` is
present, preparation and every executor effect require that exact current token and the
matching entry in the TurnPlacementSnapshot. If absent, `actor` MUST be authenticated as
the exact owner of `domain`; only that Actor may prepare or continue the invocation.
In all cases `auditCause` MUST be a preexisting compatible record in that Actor's local
audit chain with matching tenant and correlation. These map to
**C13-PREPARED-NO-TURN-OWNER** and **C13-PREPARED-NO-TURN-AUDIT**.

An **Approval** authorizes exactly one InvocationId and its `intentDigest`; an
Invocation has at most one Approval record. An `InvocationContinuation` MUST be absent
before first consumption. This maps to **C13-PREPARED-APPROVAL-UNIQUE** and
**C13-PREPARED-CONTINUATION-ABSENT**.
Approval is invocation-level, single-use, and MAY expire; expiry is terminal from `pending`
and from `approved`, so an approved Approval its Invocation never consumed still resolves.
Pending state survives process death, but resume
requires the exact token only when the header carries one. Denial or authority/digest
mismatch emits one `deniedPreEffect` Receipt per untouched item; expiry, cancellation,
or loss of a required Turn emits `cancelledPreEffect`. Neither creates an EffectAttempt.
Approval consumption, persistence of one `InvocationContinuation`, and admission of the
first EffectAttempt of the invocation are one guarded transition, so concurrent resumes
cannot both execute. The continuation binds the exact first EffectAttempt id, item
index, ordinal, claim id/owner, and item key, and the persisted attempt MUST exact-match
all of them. That EffectAttempt's `invocation` MUST equal the continuation InvocationId,
and its item index/key MUST identify an item in the bound PreparedInvocation. A malformed
or substituted firstAttempt makes the continuation invalid. The Approval is consumed
exactly once, not once per item. Where an Approval was required, every
later batch item and retry validates the persisted continuation's InvocationId,
whole-intent digest, ApprovalId, and exact persisted first-attempt identity before its own normal
authority, epoch, claim, and effect admission; it neither consumes nor recreates an
Approval. Where none was required no continuation exists, and later items and retries
proceed on that same normal admission alone. This maps to **C13-PREPARED-APPROVAL-FIRST-ATTEMPT** and
**C13-PREPARED-APPROVAL-CONTINUATION**.

### 7.4 EffectAttempt, Receipt, AuditRecord, reconciliation

An **EffectAttempt** MUST be immutable write-ahead evidence that one item may cross the
effect boundary. Retry appends a new ordinal; pre-effect denial or cancellation never
creates one. This maps to **C13-EFFECT-ATTEMPT-IMMUTABLE**.

```ts
type ItemClaimOwner =
  | { readonly kind: "executor"; readonly token: LeaseToken;
      readonly worker: ClaimWorkerId }
  | { readonly kind: "system"; readonly actor: ActorRef;
      readonly worker: ClaimWorkerId };

interface ItemClaim {
  readonly id: ItemClaimId;
  readonly invocation: InvocationId;
  readonly itemIndex: number;
  readonly attemptOrdinal: number;
  readonly owner: ItemClaimOwner;
  readonly expiresAt: Date;                  // strictly future at claim or recovery
}

interface EffectAttempt {
  readonly id: EffectAttemptId;
  readonly invocation: InvocationId;
  readonly itemIndex: number;
  readonly ordinal: number;
  readonly claim: ItemClaimId;
  readonly token?: LeaseToken;
  readonly startedAt: Date;
  readonly idempotencyKey: string;
  readonly auditCause: AuditRecordId;
}

type Receipt = PreEffectReceipt | AttemptReceipt;

interface PreEffectReceipt {
  readonly id: ReceiptId;
  readonly invocation: InvocationId;
  readonly itemIndex: number;
  readonly outcome: "deniedPreEffect" | "cancelledPreEffect";
  readonly recordedAt: Date;
  readonly reason: string;
}

type AttemptFailureKind =
  | "raised" | "deadline" | "aborted" | "domainLost" | "outputInvalid";

interface AttemptReceipt {
  readonly id: ReceiptId;
  readonly attempt: EffectAttemptId;
  readonly outcome: "succeeded" | "failed" | "indeterminate";
  readonly failure?: AttemptFailureKind;     // present exactly when outcome is "failed"
  readonly previous?: ReceiptId;
  readonly recordedAt: Date;
  readonly result?: ContentRef;
}

type BatchOutcome = "succeeded" | "partiallySucceeded" | "failed"
  | "denied" | "cancelled" | "indeterminate";

type TerminalBatchOutcome = "succeeded" | "partiallySucceeded" | "failed"
  | "denied" | "cancelled";
```

A PreEffectReceipt is terminal for its item and has no EffectAttempt or supersession.
An AttemptReceipt references one existing EffectAttempt. Its first record has no
`previous`; only an `indeterminate` chain head may be superseded, exactly once, by
`succeeded` or `failed` for the same attempt. No final Receipt may be superseded.
Attempts and Receipts are never updated or deleted. An item's current Receipt is its
PreEffectReceipt, or the chain head for its greatest attempt ordinal. A new ordinal is
allowed only after the prior ordinal is finally `failed`; neither `succeeded` nor
`indeterminate` admits a concurrent retry. These lineage rules map to
**C13-RECEIPT-IMMUTABLE**.

A `failed` AttemptReceipt MUST name exactly one **failure kind**, and the kinds are
closed: `raised` when the invoked handler signalled failure itself; `deadline` when a
host-set bound on that attempt elapsed; `aborted` when cancellation of the Turn or Run
that owns the item reached the attempt; `domainLost` when the protection domain hosting
the target stopped answering before the handler produced a result; and `outputInvalid`
when the handler resolved with a value the Operation's declared output schema (§4.1)
rejects. Exactly one applies because each names a different bound or boundary: `deadline`
bounds the attempt, `aborted` bounds its enclosing Turn or Run, and `domainLost` is the
target's own disappearance. Only `raised` originates with the invoked code, and it is
exactly the rejection §4.1's `execute` may produce; the host derives every other kind
from the seam it controls rather than from anything the target reports about itself, for
the reason §7.1 already gives — a classification the callee could author is one the
callee could choose. `outputInvalid` is a failure of the report rather than of the
effect, so it records that the effect may well have happened and its result is unusable,
which is exactly the distinction a rejection cannot carry. No kind names a result too
large to record: this document sets no size bound on a result, and a profile that
refuses a request for its size refuses it before the request leaves (§11.5), which is a
pre-effect outcome. This maps to **C13-RECEIPT-FAILURE-KIND**.

The failure kind is orthogonal to the pre-effect distinction, never a replacement for
it. Whether an effect was attempted is still answered by which Receipt variant an item
has, and by nothing else: a PreEffectReceipt says no EffectAttempt exists and the item
never crossed the boundary, an AttemptReceipt says one does. The kind answers the
different question of how an attempted effect failed, so it MUST NOT be recorded where
this document requires another outcome — a denial before the effect stays
`deniedPreEffect`, an expiry, cancellation, or loss of a required Turn before the effect
stays `cancelledPreEffect`, and an attempt whose result is not known stays
`indeterminate` until reconciliation supersedes it, because naming a kind is a
determination and a host that has one has stopped not knowing. A kind therefore adds a
dimension to an outcome the existing rules already fix: it changes no outcome, no
supersession lineage, and no retry eligibility — a final `failed` Receipt permits the
next ordinal whatever its kind — and, like claim expiry, it never enters authority
admission. This maps to **C13-RECEIPT-FAILURE-ORTHOGONAL**.

ReceiptId MUST be allocated from one owning-Actor namespace across both Receipt variants
and all items; `AttemptReceipt.previous` and `AuditKind.receiptSuperseded`'s `previous`
and `next` all refer to that same namespace. An id is never reused. This maps to
**C13-RECEIPT-ID-NAMESPACE**.

Each nonterminal item has at most one live claim. Claiming is an atomic
compare-and-set over `(InvocationId, itemIndex)`; the first claim uses attempt ordinal 0
and requires `expiresAt > now`. Claim ownership and expiry are scheduling state,
separate from attempt ordinal. An executor claim embeds the exact LeaseToken; a system
claim names its owning Actor. Only the current claim owner may append the one matching
EffectAttempt for that ordinal: when an EffectAttempt is appended, its invocation, item
index, ordinal, and optional token MUST equal the admitting claim's invocation, item
index, attemptOrdinal, and owner token. These map to **C13-CLAIM-INITIAL-ATOMIC** and
**C13-CLAIM-FUTURE-EXPIRY**.

An abandoned claim may be recovered only when `expiresAt <= now` and no EffectAttempt
exists for that claim's ordinal. Its replacement retains the same invocation, item index,
and ordinal, names a different worker, and requires a new `expiresAt > now`. Recovery
never advances the ordinal. An ordinal that already has an EffectAttempt is not eligible
for abandoned-claim recovery and follows Receipt reconciliation instead. These map to
**C13-CLAIM-RECOVERY-NO-ATTEMPT**, **C13-CLAIM-RECOVERY-NEW-OWNER**,
**C13-CLAIM-RECOVERY-FUTURE-EXPIRY**, and **C13-CLAIM-RECOVERY-SAME-ORDINAL**.

A new ordinal is claimed only after the prior ordinal has a final `failed` Receipt, which
maps to **C13-ATTEMPT-ORDINAL-AFTER-FAILURE**. Scoping recovery and ordinal advance to
the ordinal rather than the item is what keeps an item recoverable after a worker claims a
retry ordinal and stops before appending its EffectAttempt: no attempt at that ordinal
means no effect was attempted at it, because the attempt is appended in the same guarded
transaction that admits it. Pre-effect policy may terminalize an unclaimed item. A final
Receipt clears the claim; `succeeded` terminalizes the item while `failed` permits the
next ordinal. These rules apply to index 0 of a single too, and prevent two executors
from continuing one item.

`BatchOutcome` MUST be unavailable until every item has a current Receipt; those
Receipts need not be final, so the derived outcome may be `indeterminate`. A
`TerminalBatchOutcome` MUST be available exactly when the derived BatchOutcome is
non-indeterminate. Neither aggregate is a Receipt or substitutes for item evidence.
These map to **C13-BATCH-OUTCOME-COMPLETE** and **C13-BATCH-OUTCOME-TERMINAL**.
Aggregate `denied` and
`cancelled` therefore cannot be confused with the item outcomes `deniedPreEffect` and
`cancelledPreEffect`. Derivation is the first matching rule: any indeterminate →
`indeterminate`; all succeeded → `succeeded`; some succeeded → `partiallySucceeded`;
otherwise any failed → `failed`; otherwise any cancelledPreEffect → `cancelled`;
otherwise → `denied`.

For mediated external effects, intent and EffectAttempt evidence MUST precede the
effect. The call MUST carry the item's idempotency key. If its result is not known, the
pipeline appends `indeterminate`; reconciliation re-queries that same attempt by
idempotency key and appends its superseding final Receipt. A resend after final failure
is a new EffectAttempt through the normal mediated path, never an unrecorded reconciler
action. Eventual reconciliation depends only on the external liveness assumptions stated
in §14. These map to **C13-EFFECT-WRITE-AHEAD**, **C13-EFFECT-IDEMPOTENCY**,
**C13-EFFECT-RECONCILIATION**, and **C13-EFFECT-SUPERSEDING-RECEIPT**.

An **AuditRecord** is one immutable entry in an append-only typed causal chain:

```ts
interface AuditRecord {
  readonly id: AuditRecordId;
  readonly actor: ActorRef;
  readonly tenant: TenantId;
  readonly correlation: CorrelationId;
  readonly cause?: AuditRecordId;
  readonly kind: AuditKind;
}

type AuditKind =
  | { readonly kind: "invocation"; readonly id: InvocationId }
  | { readonly kind: "approval"; readonly id: ApprovalId;
      readonly phase: "pending" | "approved" | "denied" | "expired" | "consumed" }
  | { readonly kind: "attempt"; readonly id: EffectAttemptId }
  | { readonly kind: "receipt"; readonly id: ReceiptId;
      readonly outcome: PreEffectReceipt["outcome"] | AttemptReceipt["outcome"] }
  | { readonly kind: "receiptSuperseded"; readonly previous: ReceiptId;
      readonly next: ReceiptId }
  | { readonly kind: "write"; readonly id: WriteRecordId; readonly outcome: WriteRecord["outcome"] }
  | { readonly kind: "event"; readonly id: EventId }
  | { readonly kind: "routeReserved"; readonly id: RouteReservationId }
  | { readonly kind: "routeProjected"; readonly projection: RouteProjectionId;
      readonly reservation: RouteReservationId }
  | { readonly kind: "delivery"; readonly reservation: RouteReservationId }
  | { readonly kind: "commit"; readonly id: RunCommitId };
```

```text
Invocation → Approval(approved) → EffectAttempt → Receipt → Event → RouteReserved
Invocation → EffectAttempt
Invocation or Approval(denied|expired) → pre-effect Receipt
indeterminate Receipt → ReceiptSuperseded
Receipt or ReceiptSuperseded → Commit
source RouteReservation ═ authenticated projection ═> target RouteProjected(root) → Delivery → Commit
```

The permitted local typed edges are exactly: Invocation → Approval, EffectAttempt,
pre-effect Receipt, or WriteRecord; approved Approval → EffectAttempt; denied Approval
→ denied Receipt; expired Approval → cancelled Receipt; EffectAttempt → attempted
Receipt; indeterminate Receipt → ReceiptSuperseded; Receipt → Event or Commit;
ReceiptSuperseded → Event or Commit; Event →
RouteReserved; RouteProjected → Delivery; Delivery → Commit. ReceiptSuperseded is a
specialized append caused by its prior indeterminate Receipt and names the final next
Receipt. Every cause MUST exist before append and share tenant and correlation; append
never rewrites an entry.
Invocation records are ordinary roots. A `routeProjected` record is the special
target-local bridge root described below, not an ordinary root. A host-created
command-rejection WriteRecord MAY also be a root only under the §8.5 no-caller-cause
rule. These map to **C13-AUDIT-EDGE-RELATION**, **C13-AUDIT-PREEXISTING-CAUSE**, and
**C13-AUDIT-APPEND-ONLY**.

Cross-Actor causality MUST NOT point directly into another Audit log. The source-owned
RouteReservation is the authenticated bridge. The target's `routeProjected` entry is a
target-local bridge root with no AuditRecord cause; it is admitted only by authenticating
that reservation projection. Delivery is caused by the target-local projection entry.
This maps to **C13-AUDIT-ROUTE-BRIDGE**.

The reservation cites the preexisting source Event audit cause and MUST authenticate
source Actor, target Actor, tenants, projection, authority, and stable InvocationId.
Cross-tenant delivery also verifies the reservation's explicit cross-tenant Binding.
These map to **C13-ROUTE-SOURCE-EVENT**, **C13-ROUTE-AUDIT-CAUSE**,
**C13-ROUTE-TENANT-RELATION**, and **C13-ROUTE-STABLE-INVOCATION**.

Every Receipt outcome has an AuditRecord. Attempted outcomes are caused by their
EffectAttempt audit; pre-effect outcomes are caused by Invocation or terminal Approval
audit. Indeterminate supersession gets a separate `receiptSuperseded` entry linking both
Receipt ids before the final Receipt is observed. Every SystemCause MUST name the exact
preexisting receipt, delivery, or control AuditRecord required by the writer
matrix. Telemetry is diagnostic
and never substitutes for a Receipt, RouteReservation, WriteRecord, or AuditRecord. This
maps to **C13-AUDIT-TELEMETRY-EXCLUDED**.

---

## 8. Substrates (L5)

### 8.1 Actor

An **Actor** is a durably addressable state machine with one authoritative
coordination unit owning its mailbox, local transaction boundary, lifecycle, recovery,
and fencing state. It MUST serialize conflicting commands, recover state before serving,
commit at declared linearization points, and reject stale fences. Actor roles:
Tenant, Workspace, Run (when dedicated), Environment, Slate host. This maps to
**C13-OWNERSHIP-ACTOR-CONTRACT**.

### 8.2 ContentStore

```ts
abstract class ContentStore {
  abstract put(bytes: Uint8Array, hint?: MediaHint): Promise<{ ref: ContentRef; digest: Digest }>;
  abstract get(ref: ContentRef, range?: ByteRange): Promise<Uint8Array>;
  abstract stat(ref: ContentRef): Promise<ContentStat | undefined>;
}
```

Every `ContentRef` in this specification MUST resolve through a ContentStore — run
inputs, checkpoints, instructions, results, slate sources. A ContentStore belongs to
exactly one Tenant (§3.2, §8.4 rule 1), and a `ContentRef` resolves only for a caller
whose authority reaches that Tenant; there is no cross-Tenant content read without a
Grant that says so. This maps to **C13-CONTENT-RESOLUTION**.

A reference alone keeps nothing alive. Every durable record type that names a `ContentRef`
is a retained owner of that content for as long as the record exists, and the §8.4 rule 6
ownership map — record type → owning Actor, already required — is where that fact is
declared: which field names the reference and which retention owner holds it, one more
column on a map that already exists, not a new artifact. Collection offers only content no
declared retainer owns. For a record kind whose lifecycle defines removal — a compacted
View or ViewDelta revision, for instance — removing the record releases its ownership. For
a record kind this document declares append-only and undeletable — a Receipt, an
AuditRecord, a RunCommit (§5.2, §7.4, §8.3) — removal never occurs, so release never fires
for it either: such a record retains its named content for its own full durable lifetime,
bounded only by Tenant-level retention policy (export, legal deletion, Tenant closure), not
by a per-record release step. Either way, retention and GC follow Tenant policy over content
no declared retainer owns, so a record cannot outlive the bytes it names. This maps to
**C13-CONTENT-CUSTODY**.

### 8.3 Records and codecs

Durable records are data. Every record type defines a stable serialized form with a
**versioned codec**, used identically for storage, the command protocol, and
export/import. A codec MUST upcast records of an older minor within the same major, and
MUST reject an unknown major — newer or older — and an unknown newer minor with a typed
error, never a silent truncation. Live behavior wraps records; it never *is* the
record, and durable records never own live substrate resources. This maps to
**C13-CODEC-VERSIONING**.

### 8.4 State-ownership rules

1. Every record type names exactly **one owning Actor**.
2. Other actors hold identifiers and rebuildable indexes only. An index maps id →
   locator and is disposable; a Workspace's index over dedicated Runs is constrained
   to `{ runId, actor locator, pins, terminal outcome, settled }` and never carries replayable
   Run state.
3. Caches are derived, versioned, rebuildable; a cache miss is never an error.
4. Cross-actor reads use RPC or explicitly versioned snapshots — never dual writes.
5. Authority resolution returns complete PathEpochEvidence; direct and mediated paths
   enforce §3.4 rules 5–8. Rules 1–4 map to **C13-OWNERSHIP-SINGLE-OWNER**.
6. Conformance includes an **ownership map** artifact — record type → owning Actor —
   verified against the implementation.

In particular, the Tenant Actor MUST be the sole durable owner of Binding, Grant, and
ScopeEpoch records. Creating, replacing, or deactivating a Binding and advancing its
affected path epoch MUST occur in one Tenant-local control transaction. Workspace and
Run Actors MAY retain Binding ids and rebuildable indexes, never canonical or mirrored
Binding records. This maps to **C13-OWNERSHIP-AUTHORITY-RECORDS**.

These rules exist because mirrored state is the most expensive class of bug a durable
platform can have: two copies of the truth always eventually disagree, and by the time
they do, both copies have already been read by something.

### 8.5 The command protocol

Protocol **commands** (controller contracts — distinct from the user-facing Commands
of §4.3) are how coordination is implemented. Every mutating command defines
authority, valid lifecycle state, linearization point, durable mutation, emitted
observation, reply, retry, and reconciliation behavior. Reference command families: Tenant,
membership, resource, Grant, Binding, Event, Subscription, Run, Turn, RunBranch,
RunCommit, Invocation, Approval, Environment, and Workspace portability.

A conforming substrate provides a **dispatcher** that enforces the envelope at the
protocol boundary. The families include allow/deny Grant, Binding, RouteReservation,
RunPins migration, PreparedInvocation, Approval consumption, EffectAttempt, Receipt,
and AuditRecord append commands.

```ts
type CommandCaller =
  | { readonly kind: "principal"; readonly principal: PrincipalRef }
  | { readonly kind: "actor"; readonly actor: ActorRef };

interface CommandEnvelope {
  readonly command: string;
  readonly caller: CommandCaller;
  readonly idempotencyKey: string;
  readonly expectedRevision?: Revision;
  readonly lease?: LeaseToken;
  readonly callerCause?: AuditRecordId;
  readonly payload: ContentRef;
  readonly payloadDigest: Digest;
}

type CommandOutcome =
  | "committed"
  | "rejectedMalformed"
  | "rejectedAuthentication"
  | "rejectedAuthority"
  | "rejectedLifecycle"
  | "rejectedRevision"
  | "rejectedLease"
  | "duplicate";

interface WriteRecord {
  readonly id: WriteRecordId;
  readonly actor: ActorRef;
  readonly envelopeDigest: Digest;
  readonly caller?: CommandCaller;            // absent only when malformed before decode
  readonly command?: string;
  readonly at: Date;
  readonly outcome: CommandOutcome;
  readonly audit: AuditRecordId;
  readonly duplicateOf?: WriteRecordId;       // present exactly for duplicate
}
```

The dispatcher MUST evaluate in this order: decode/shape, authenticate exact caller,
duplicate lookup on `(caller, idempotencyKey)`, authority, lifecycle, expected revision,
optional LeaseToken, then mutation. A Turn-owned command requires a token; a supplied
token MUST always be checked for exact Turn, holder, epoch, and non-expiry. Missing
required, unexpected, stale, wrong-Turn, or expired tokens yield `rejectedLease`.
Duplicate MUST return the original reply and record `duplicateOf` without re-running
later gates or mutation. These map to **C13-PROTOCOL-OUTCOMES**,
**C13-PROTOCOL-EXACT-ENVELOPE**, and **C13-PROTOCOL-DUPLICATE**.

Each command family MUST declare whether `expectedRevision` is required and whether a
LeaseToken is required, optional, or forbidden. Missing required envelope fields and
forbidden fields are `rejectedMalformed`, except token-policy violations, which are
`rejectedLease`. This maps to **C13-PROTOCOL-FAMILY-ENVELOPE-POLICY**.

Every request appends exactly one WriteRecord and one linked AuditRecord, including
malformed and rejected requests. A valid `callerCause` MUST preexist and be a permitted
typed cause. When rejection has no usable caller cause, the host creates an attributable
root `write` AuditRecord; malformed input may omit caller and command. An accepted
request without a caller cause first receives a host-created Invocation root. The
envelope digest covers the raw submitted envelope even when decode fails. WriteRecord
and AuditRecord contain each other's preallocated ids and commit atomically
with the decision. RunCommit commands additionally enforce §5.2. Cross-Actor
observation is post-commit and uses §6.2 reservation bridges. The rejection-root rule
maps to **C13-PROTOCOL-REJECTION-ROOT**.

---

## 9. The definition plane (L6)

### 9.1 Package

A **Package** is the distributable unit: one or more FacetManifests, code references,
version, compatibility range, provenance, config-schema fragments. Packages are
inspectable without execution — hosts, registries, and the Blueprint validator read
manifests as data. Registry governance is out of scope; the package shape is not.

A Package declares its **dependencies** as data: a set of
`{ id: PackageId, range: CompatRange }` entries, unique by `id`, read alongside its
manifests without executing anything. The closure `RunPins.packages` pins (§5.2) is
exactly the transitive closure of that declared relation from the Blueprint's `packages`
list, resolved to exact versions; a pinned closure that is not the closure of a declared
relation is invalid rather than merely unexplained. The closure is finite and unique by
`PackagePin.id`, so it is computable whether or not the declared relation is acyclic. An
unsatisfiable range, or a dependency on a Package the Blueprint does not install, rejects
the Blueprint before any package code loads (§9.2). A dependency relates Package releases
and is never a `FacetManifest.bindings` entry: a dependency names code a release needs
present, a `BindingRequirement` names a live capability a Facet needs bound (§4.1), the
two are resolved by different planes, and a host MUST NOT derive either from the other.
This is the same discipline the manifest/runtime split already applies to contributions —
what decides whether a composition is admissible is data a host reads, never behavior it
runs. This maps to **C13-PACKAGE-DEPENDENCY-DECLARED**.

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

`policies.placement` decides isolation (§1.5) using one explicit preference order.
For each Facet, compute exactly `manifest ∩ policy ∩ substrate ∩ trust`, where each term
is an independently derived admissible-mode set. One preference order applies
everywhere: `dynamic`, then `provider`, then `bundled`. Placement MUST be the first
member of the intersection in that order. An empty intersection MUST reject the
Blueprint; no fallback is inferred. These map to **C13-PLACEMENT-INTERSECTION**,
**C13-PLACEMENT-ORDER**, and **C13-PLACEMENT-EMPTY**.

`policies.placement.trusted` names the Packages the trust set
admits to `bundled`, as a nonempty list of globs matched against the whole `PackageId`:
`*` matches any sequence of characters, including none, everywhere it appears in the
pattern; every other character matches itself; a pattern with no `*` matches only that
exact id. The trust set MUST exclude `bundled` for every Package no glob matches. If the
chosen mode cannot admit a policy-selected direct call, that call MUST escalate to
mediated (§7.2); placement itself does not change. These map to
**C13-PLACEMENT-UNTRUSTED-BUNDLED** and **C13-POLICY-DIRECT-ESCALATION**.

The composed platform config schema is the spec's base schema plus every installed
package's `settings` fragments, and a Blueprint MUST validate against it **before any
package code loads**. This maps to **C13-BLUEPRINT-VALIDATE-BEFORE-LOAD**.

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
    "placement": {
      "trusted": ["core.*"],
      "allowed": ["provider", "dynamic"]
    },
    "tiers": { "acme.deploy:deploy.run": "mediated" }
  }
}
```

### 9.3 Materialization

A **materializer** MUST project a Blueprint into records — Facet installs, Bindings,
Subscriptions, slots, policies, scope scaffolding — **idempotently**: re-applying
reconciles (create, update, remove-managed) rather than duplicates. Materialized
records are marked Blueprint-managed; manual edits to managed records are rejected or
adopted explicitly, per policy. The materializer enforces slot contribute-authority
(§4.2), command uniqueness (§4.3), and role→Grant materialization (§3.3) through the
same records the runtime uses. Reconciliation on a live platform MUST order changes so
existing RunPins remain resolvable (§5.2); removing a pinned Package is deferred until no
Run, Turn, Session, tree checkpoint, or Snapshot pins that release, or performed through
explicit Run migration — never silent. These map to **C13-BLUEPRINT-REMATERIALIZE** and
**C13-BLUEPRINT-RUN-PINS**.

Re-materialization is **convergent as well as idempotent**: the Blueprint-managed record
set a Scope holds once it is converged is a function of the Blueprint alone, independent
of the order in which the materializer issued the admissible installs, updates, and
withdrawals and of the managed record set the Scope held before. Records no Blueprint
declares — Runs, Turns, Events, Receipts, and everything else §8.4 assigns an owning
Actor — lie outside the managed set and outside this property, so a manual edit is
adopted only as a change to the Blueprint, and an edit no Blueprint change expresses is
rejected rather than adopted as an unattributed managed record. A deferral does not
weaken convergence, because a deferral is itself a durable **pending obligation** naming
the exact record it holds, the exact reason it is held, and the exact condition that
discharges it. A host MAY defer only where this document states both the deferral and
that condition, and the four it states are a withdrawal held by §4.1's reliance guard,
discharged when no active Facet relies on the withdrawing Facet; each admitted Invocation
item draining against a withdrawing Facet (§4.1), discharged when that item holds a
terminal current Receipt; each RouteReservation the withdrawal's retired Subscriptions
leave unadmitted (§4.1, §6.2), discharged when its owning Actor has written its terminal
rejected RouteDelivery; and a Package retained because §5.2 still pins it, discharged
when no Run, Turn, Session, tree checkpoint, or Snapshot pins that release or a Run
explicitly migrates. A materializer's reconciliation outcome MUST carry its pending set,
and a Scope is **converged** exactly when that set is empty and **converging** otherwise,
so no host states convergence apart from the records that would contradict it. A
divergence a host cannot express as a pending obligation with a discharging condition is
a rejected reconciliation, refused at validation before any package code loads (§9.2),
never an accepted reconciliation left indefinitely pending. Convergence fixes the
endpoint and does not promise arrival, and this document claims no quiescence: the
obligations one withdrawal opens are finite and never grow, because the transaction that
begins the withdrawal stops admitting work against the Facet (§4.1), so no obligation
waits on one created after it; a reliance obligation discharges with no further act,
since §4.1 rejects a reliance cycle and each held withdrawal therefore waits only on
withdrawals ahead of it; a draining item and an unadmitted reservation each settle under
the eventual delivery and reconciliation §14 states as external premises; and a Package
retention waits on pins nothing here promises release, so what the obligation guarantees
is that the outstanding Operation is named and inspectable, never that someone performs
it. This maps to **C13-BLUEPRINT-CONVERGENCE**.

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
| Tenant Actor | one Durable Object per Tenant (SQLite): principals, teams, memberships, Projects, canonical Bindings, allow/deny Grants, path epochs and invalidation holders, credential custody, quotas |
| Workspace Actor | one DO per Workspace (SQLite): facet installs, Binding ids and rebuildable lookup indexes only, its event log, subscriptions, runs (default) or run index (dedicated), tasks |
| Run | Workspace-owned by default; MAY be pinned `dedicated` at start. Its owner retains RunPins, active/terminal outcome, graph, and derived Settled obligations; migration only per §5.2. Maps to **C13-CLOUDFLARE-RUN-HOSTING**. |
| Turn execution | in the Run-owning DO; each Turn retains a placement snapshot, and offloaded callbacks carry exact Turn, holder, and epoch — delivery is at-least-once and mismatches reject |
| Environment | Sandbox SDK container or session DO; tree checkpoints and filesystem durability via R2 snapshots; preview via authenticated exposed ports |
| Slate | records in the owning DO; frontend on static assets; backend as dynamic-mode code (§10.2) |
| ContentStore | R2, with DO SQLite for small content, content-addressed; the store and its owner edges are owned by the Tenant Actor |
| Events | owned by the accepting Actor. Cross-Actor delivery uses a source-owned authenticated RouteReservation with stable InvocationId and a target-local delivery record; Queues/RPC may redeliver but cannot remap or duplicate intent. |

Projects are records in the Tenant DO — grouping adds zero DOs. Authority resolution
returns complete PathEpochEvidence. The profile MUST monotonically deliver invalidation
watermarks, atomically advance them on mediated stale observation, enforce the exact
Turn lease and immutable deadline for direct calls, perform Actor-local final authority
admission in the attempt transaction, and perform cross-DO final authority admission at
Tenant permit issuance after exact claim identity is known (§3.4, §10.3). The watermark
obligation maps to **C13-AUTH-WATERMARK-MONOTONE**.

![Cloudflare topology](diagrams/cloudflare.svg)

### 10.2 Facet hosting

Placement follows the §9.2 admissible-set intersection and preference order. It is
**not** one Worker per Facet — isolation boundaries are drawn exactly
where protection domains change, and same-domain separation is fanout and cold-start
tax with no security benefit:

1. **Bundled** — facet code ships in the platform Worker and runs in-process inside
   the hosting Actor. Turn-scoped resolutions; eligible for `direct` (§7.2).
   First-party facets — fs, shell, memory, tasks, chat — live here, by policy grant.
2. **Provider** — a separate Worker or service behind a service binding or
   capability-RPC stub (Workers RPC / Cap'n Web). This is where custody demands
   isolation: third-party integrations and credential-holding approval gateways. RPC stubs
   do not survive execution contexts, hibernation, or isolate eviction, so provider
   resolutions are scoped to a single Turn step and re-resolved with current path
   epochs each step (§3.4 rules 7–8). Revocation drops the stub; so do platform
   lifecycle events; re-resolution is the uniform recovery for both.
3. **Dynamic** — two named backings (§4.7), both loading code into a fresh isolate:
   `workerLoader`, code loaded via Worker Loader, and `dispatchNamespace`, pre-deployed
   code loaded via a Workers-for-Platforms dispatch namespace — the agent-authored code
   of §4.7 (programmatic tool calls, Slate backends, agent-authored facets) runs under
   either. Hosts pass `globalOutbound: null` (or equivalent); this is how the substrate
   satisfies §1.5's no-ambient-egress requirement, and capabilities arrive only as
   explicitly passed Bindings — a delegation under §3.4 (§4.7), not a copy of the
   loader's authority. Worker Loader is in open beta at the time of writing;
   `dispatchNamespace` serves as the GA fallback for pre-deployed code — Slate backends,
   agent-authored facets — with identical authority semantics, including that one.
   Which backing serves which §4.7 consumer is the platform's declaration to make.

### 10.3 Implementation constraints

Cross-DO mediated authority uses this profile record:

```ts
interface AuthorityPermit {
  readonly tenant: TenantId;
  readonly issuer: ActorRef;                 // authoritative Tenant Actor
  readonly source: ActorRef;
  readonly target: { readonly actor: ActorRef; readonly fence: number;
      readonly domain: ProtectionDomain };
  readonly principal: PrincipalRef;
  readonly binding: { readonly name: BindingName; readonly generation: Revision };
  readonly facet: FacetRef;
  readonly operation: OperationRef;
  readonly package: PackagePin;
  readonly impact: Impact;
  readonly invocation: InvocationId;
  readonly reservation: RunAdmissionReservation;
  readonly itemIndex: number;
  readonly attemptOrdinal: number;
  readonly claim: ItemClaimId;
  readonly claimOwner: ItemClaimOwner;
  readonly itemKey: string;
  readonly argumentsDigest: Digest;
  readonly intentDigest: Digest;
  readonly pathEpochs: PathEpochEvidence;
  readonly authority: InvocationAuthority;
  readonly lease?: LeaseToken;
  readonly nonce: string;
  readonly requestDigest: Digest;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}
```

After the target has durably established the exact item claim and Run admission
reservation, it MUST durably record one immutable target request containing every
would-be permit field except `requestDigest` and `issuedAt`, together with the full
canonical `AuthorityCheckRequest`. The request digest covers that exact record,
including its nonce and expiry. The authenticated transport caller MUST be the target
Actor named by the request; the Tenant does not mirror or claim ownership of the
target's fence. The Tenant Actor issues this short-lived permit as the final
authority-admission linearization point immediately before target attempt admission.
Issuance is one Tenant transaction against the authenticated immutable request, current
Grants, Binding generation, complete path epochs, qualified PrincipalRef, and optional
exact lease. The Tenant MUST reject a request whose expiry is not strictly after the
issuance clock, and the issued permit MUST bind the exact request digest. An exact
previous issuance may be replayed after response loss while it remains valid; its
original `issuedAt` is immutable. Revocation or epoch
mutation committed before issuance blocks it; mutation after issuance does not cancel
that admitted permit but blocks every later issuance. The target Actor authenticates
issuer and source, exact-matches every bound field to the persisted PreparedInvocation,
Run reservation epoch, local claim id/owner, package pin, and target fence/domain,
requires `issuedAt <= now < expiresAt`, exact-matches `requestDigest` to its retained
target request, and atomically records a separate exact-permit consumption with
EffectAttempt admission. Consumption MUST retain rather than delete or replace the
immutable target request; both records survive restart, and recovery MUST fail closed
unless the request and consumption still match exactly. A nonce is single-use even
after expiry. A missing request, mismatch, substitution, replay, closed or changed
reservation epoch, stale local claim/fence, or expiry records a pre-effect denial and
no EffectAttempt. A newer
target-local watermark arriving after issuance MUST NOT reject, cancel, or stale a
valid issued permit: issuance is irreversible authority admission. Target watermark
join and stale-denial evidence occur only when issuance failed, the permit is
expired/substituted/invalid, or an unissued intent is compared. Post-issuance revocation
blocks only future permit issuance. The permit
delegates no ambient authority and creates no cross-DO transaction. These clauses map to
**C13-CLOUDFLARE-AUTHORITY-PERMIT-BINDING** and
**C13-CLOUDFLARE-AUTHORITY-PERMIT-CONSUMPTION**.

- DO SQLite is synchronous; the dispatcher's envelope check plus guarded mutation is
  one synchronous span with no intervening `await` (input-gate hazard, §8.5).
- Platform and Slate-backend deployment uses dispatch namespaces; per-app resources
  (D1, KV) are provisioned at first need and recorded on the owning Slate record.

### 10.4 Durable execution

This profile rests its durability on four platform mechanisms: the object's alarm, its
reconciliation outbox, its hibernating sockets, and its SQLite storage. Each is a place
a substrate can satisfy the local runtime and still diverge in production, so the
conformance evidence for the rules below is taken from a deployed account.

A Durable Object has exactly one alarm, so no scheduler inside it writes that alarm
directly: each records a durable per-owner claim, and the physical alarm tracks the
earliest live claim. Setting, advancing, or releasing one owner's claim MUST leave every
other owner's wakeup armed, a claim that fires releases only itself, and the alarm falls
back to the earliest surviving claim or is torn down when none remains. The claim table,
not the platform's alarm slot, is the state that arbitration is repaired from. This maps
to **C13-CLOUDFLARE-ALARM-CLAIMS**.

Alarms drive schedules (idempotency key = `(subscription, fireTime)`) and serve as the
reconciliation driver (§7.4): an alarm sweep re-queries indeterminate attempts and
appends final Receipts; retry creates a new mediated EffectAttempt. Workflows
`step.waitForEvent` MAY serve as the driver for provider-callback flows instead. The
driver holds one claim tracking the earliest entry of a durable reconciliation outbox —
armed when an entry is enqueued, rebuilt from the outbox when the Actor starts, and
released once the outbox drains — so no due entry is left without a wakeup and no
drained outbox is left holding one. This maps to
**C13-CLOUDFLARE-RECONCILIATION-DRIVER**.

An armed alarm is durable state rather than a live timer, and its recovery belongs to
the platform. Losing the instance MUST NOT drop the schedule: the platform
re-instantiates the object and fires the alarm on schedule without anything outside the
object having touched it. A handler that throws leaves its entry unacknowledged, and the
platform re-fires the alarm a bounded number of times before it stops. Durability
therefore MUST NOT rest on re-firing: the outbox is the source of truth, and the Actor
MUST rebuild the alarm from it on start, so an object whose retries were exhausted
re-arms the moment it is next instantiated. Because recovery is the platform's and the
object's own, a conforming deployment MUST NOT need an external timer, cron, or
keepalive request to re-arm work it has already armed. This maps to
**C13-CLOUDFLARE-ALARM-DURABILITY**.

A reconciliation that fails is rescheduled, never acknowledged: the sweep records the
failure, moves that entry to a bounded retry time, re-arms the alarm for it, and the
entry settles under the same driver on a later sweep. A sweep that fails before reaching
its entries floors the re-arm one retry delay out instead of at the past schedules it
never read, which would refire immediately and spin. This maps to
**C13-CLOUDFLARE-RECONCILIATION-RETRY**.

Reconciliation awaits application work with the object's input gate open, so a request
can reschedule an entry while the sweep that read it is still running. Acknowledgement
and reschedule therefore fence on the schedule the sweep observed: an entry whose
schedule moved underneath the sweep MUST survive it with the newer schedule intact and
the alarm pointing at that schedule, and an entry whose schedule still matches is
cleared. This maps to **C13-CLOUDFLARE-RECONCILIATION-FENCE**.

WebSocket surfaces use hibernation. ViewDelta streaming requires a durable, compactable
delta/snapshot log keyed by revision in the owning DO, and the per-socket last-acked
revision cursor in the WebSocket attachment (≤ 16 KB); replay cost is bounded by
periodic snapshots. The attachment is that cursor's only home, so the cursor MUST
survive hibernation and isolate eviction in the attachment alongside the open socket: a socket resumed in a new
isolate replays exactly the revisions past its acknowledged cursor, and an acknowledged
revision is never replayed to it again. This maps to **C13-CLOUDFLARE-VIEW-ATTACHMENT**.

Queues and Workflows are at-least-once with no platform-fenced DO callback; all fencing
is the application-level lease epoch (§5.3). A delivery the target accepts is
acknowledged and MUST NOT be handed back; one the target declines is retried and
redelivered. A message whose body carries no decodable delivery identity MUST NOT reach
the target and MUST NOT be acknowledged either, because acknowledging destroys it: it is
retried until the queue's own dead-letter policy takes custody, while the rest of its
batch keeps its own dispositions. This maps to **C13-CLOUDFLARE-QUEUE-DISPOSITION**.

DO SQLite bounds the size of a stored string, BLOB, or row, and this profile declares
that bound as a value the deployed platform accepts with row overhead included — not
merely one the local runtime accepts. Every durable write seam MUST refuse an
over-limit payload as invalid input before opening a transaction, since the runtime
would otherwise surface the bound as an opaque statement failure partway through one,
and the refusal MUST leave the object serving and its durable log unchanged. This maps
to **C13-CLOUDFLARE-STORAGE-LIMIT**.

Durable state is independent of the deployed code version. Deploying a new Worker MUST
NOT clear alarm claims, the physical alarm, reconciliation outbox entries, or the view
revision log, and the new version resumes that work rather than restarting it: a
schedule armed by the previous version fires under the new one and settles there.
Continuity is not directional: replacing a release with the one before it MUST NOT clear
that state either, and the work resumes as soon as a release that can read the object's
schema serves it again. This maps to **C13-CLOUDFLARE-DEPLOYMENT-CONTINUITY**.

Durable state outlives the release that wrote it, so a migration is additive. Applying a
release's migrations MUST leave every table, column, index, and constraint the previous
release reads exactly as that release reads it, and MUST NOT drop, rename, retype, or
narrow one, or rewrite rows an earlier release wrote. A column added to a table an
earlier release created MUST be one that release can omit, because its writes name only
the columns it knows. Destructive schema change is not forbidden; it costs two releases.
Release N adds the new shape and reads both shapes, backfills, and release N+1 removes
the old shape once release N-1 has left support. A convention does not establish this, so
this profile's conformance evidence includes a mechanical check that applies every
declared migration to the schema its predecessors produced and refuses a non-additive
one. This maps to **C13-CLOUDFLARE-ADDITIVE-MIGRATION**.

Because every release is additive, the supported rollback window is exactly one release.
An object that ran release N and is served by release N-1 again carries one schema marker
that release does not declare, and a schema a release does not declare MUST NOT be read:
the object fails closed. That refusal belongs to the object's operations and not to its
construction. Construction MUST succeed, since an object that cannot be constructed
cannot be inspected, exported, diagnosed, or drained, and every operation on an object
whose applied schema the running release does not declare MUST fail with this profile's
stable unreadable-schema code rather than a generic decoding failure. Refusing MUST leave
the durable state untouched, so deploying a release that declares those markers restores
service with no repair step. Rolling back two or more releases is undefined: it fails
closed the same way, and rolling forward is its only recovery. This maps to
**C13-CLOUDFLARE-ROLLBACK-WINDOW**.

---

## 11. Profiles

- **P11-BASE-COMPOSITION** A profile is a named, conformance-testable composition of primitives, never a new primitive.
- **P11-BASE-CONTRACT** Each profile specifies its Operations, Events, invariants, and conformance obligations; a profile with no listed Event makes no Event-emission promise.
- **P11-BASE-NAMES** Operation names are conventional; a platform MAY rename them but MUST preserve applicable impacts and invariants.
- **P11-BASE-TESTS** Each claimed profile MUST provide tests for its listed Operations and invariants, plus Event shape and causality where Events are listed.
- **P11-BASE-EVIDENCE** Conformance evidence is governed by §13; this section makes no claim about test implementation status.

### 11.1 Filesystem

- **P11-FILESYSTEM-READ** Operation `read` has `observe` impact.
- **P11-FILESYSTEM-STAT** Operation `stat` has `observe` impact.
- **P11-FILESYSTEM-LIST** Operation `list` has `observe` impact and is paged and stat-inclusive.
- **P11-FILESYSTEM-WRITE** Operation `write` has `mutate` impact and supports create, replace, and upsert modes.
- **P11-FILESYSTEM-WRITE-OBSERVED** Mode `replace` names the `Digest` (§1.4) of the content it replaces and the store admits the write only when the target's current content digests to that value, so the request carries its own proof of observation and the profile keeps no per-session observed-state ledger.
- **P11-FILESYSTEM-WRITE-UNOBSERVED** Mode `upsert` names no digest and is the profile's only write over unobserved content, so overwriting content the caller never read is a declared `mutate` intent a Workspace policy can refuse rather than the default shape of a write.
- **P11-FILESYSTEM-WRITE-GUARD-ATOMIC** The store compares the named digest and applies the content in the single atomic step `P11-FILESYSTEM-ATOMIC-WRITE` already requires, so no write lands between the comparison and the replacement.
- **P11-FILESYSTEM-WRITE-GUARD-PORTABLE** The guard value is a content digest rather than a store-native version token, so one guarded write contract holds across every backing store and wrapper `P11-FILESYSTEM-BACKINGS` covers without a per-store token translation.
- **P11-FILESYSTEM-REMOVE** Operation `remove` has `mutate` impact.
- **P11-FILESYSTEM-MOVE** Operation `move` has `mutate` impact and is same-filesystem only.
- **P11-FILESYSTEM-MKDIR** Operation `mkdir` has `mutate` impact.
- **P11-FILESYSTEM-SESSION-DIRECT** A mutating Operation is direct-tier eligible only under the §7.2 floor, which requires the target to be a Turn-owned Session's own filesystem.
- **P11-FILESYSTEM-RECEIPT** Every mediated mutating Operation records the canonical mediated Invocation `Receipt`; the profile defines no second Receipt type.
- **P11-FILESYSTEM-PATHS** Paths are normalized and cannot traverse outside the root; escape rejects with stable `path.invalid`, never a silent clamp.
- **P11-FILESYSTEM-RANGES** Reads are byte-ranged.
- **P11-FILESYSTEM-ATOMIC-WRITE** Writes are atomic at path granularity.
- **P11-FILESYSTEM-ERROR-CLOSED** Filesystem errors use one fixed, stable code set.
- **P11-FILESYSTEM-ERROR-CODES** The set is `not-found`, `exists`, `not-a-directory`, `is-a-directory`, `path.invalid`, `too-large`, and `content-mismatch`.
- **P11-FILESYSTEM-ERROR-CONTENT-MISMATCH** A `replace` whose named digest differs from the target's current content rejects with `content-mismatch`, distinct from `not-found` for an absent target and from `exists` for a `create` over a present one.
- **P11-FILESYSTEM-ERROR-BRANCHING** Callers branch on stable codes, not messages.
- **P11-FILESYSTEM-SUITE** One complete reader and mutator contract governs filesystem conformance.
- **P11-FILESYSTEM-BACKINGS** That contract holds for every backing store and every observed and mount-composition wrapper.
- **P11-FILESYSTEM-READONLY** A readonly wrapper exposes only the reader contract and no mutating Operations; it does not accept a mutation and synthesize a profile-specific error.
- **P11-FILESYSTEM-CODE-ASSERTIONS** The suite asserts the complete stable code set.
- **P11-FILESYSTEM-ATOMICITY-ASSERTIONS** The suite asserts write atomicity.
- **P11-FILESYSTEM-PAGING-ASSERTIONS** The suite asserts stat-inclusive paging.
- **P11-FILESYSTEM-MOVE-ASSERTIONS** The suite asserts same-filesystem move semantics.

### 11.2 Shell

- **P11-SHELL-RUN** Operation `run` has `execute` impact and is direct-tier eligible only under the §7.2 floor, which requires a Turn-owned Session (§4.5).
- **P11-SHELL-CANCEL** Operation `cancel` has `mutate` impact.
- **P11-SHELL-COMPOSITION** Shell is composed from Filesystem and Environment.
- **P11-SHELL-PARSER** A parser tokenizes the command line.
- **P11-SHELL-REGISTRY** A command registry resolves built-ins and explicitly declared external commands.
- **P11-SHELL-UNKNOWN** Unknown commands reject rather than implicitly handing off.
- **P11-SHELL-STREAMS** Standard input, output, and error are streamed.
- **P11-SHELL-FILESYSTEM** Shell filesystem Operations are the Filesystem profile bound to session `env.fs`.
- **P11-SHELL-SINGLE-AUTHORITY** Shell has no second filesystem authority.
- **P11-SHELL-CANCELLATION** Cancellation is prompt and leaves the Session usable.
- **P11-SHELL-BOUNDARY** A command escaping the Session filesystem boundary fails with the Filesystem code set.
- **P11-SHELL-HANDOFF** External execution handoff is an explicitly declared command, never implicit fallthrough.

### 11.3 Memory

- **P11-MEMORY-REMEMBER** Operation `remember` has `mutate` impact.
- **P11-MEMORY-RECALL** Operation `recall` has `observe` impact.
- **P11-MEMORY-FORGET** Operation `forget` has `mutate` impact.
- **P11-MEMORY-COMPOSITION** Memory is composed from Facet, Operations, and a prompt contribution.
- **P11-MEMORY-CANONICAL** Canonical content is stored once.
- **P11-MEMORY-INDEXES** Full-text, vector, or combined indexes are rebuildable caches over canonical content.
- **P11-MEMORY-PROMPT** The prompt contribution surfaces the most relevant recalled content.
- **P11-MEMORY-DISCOVERY** `recall` never returns content the caller could not read directly under §3.4 rule 4.
- **P11-MEMORY-REBUILD** Indexes are derived and a rebuild is not observable to callers.
- **P11-MEMORY-PRUNE-PAST** Pruning removes only content past retention.
- **P11-MEMORY-PRUNE-WITHIN** Pruning never silently drops content within retention.

### 11.4 Task

- **P11-TASK-CREATE** Operation `create` has `mutate` impact.
- **P11-TASK-UPDATE** Operation `update` has `mutate` impact.
- **P11-TASK-LIST** Operation `list` has `observe` impact.
- **P11-TASK-COMPOSITION** Task is composed from Facet, Operations, and a task-board Surface.
- **P11-TASK-HIERARCHY** Tasks form an acyclic hierarchy.
- **P11-TASK-RUN-RELATION** A Task MAY relate to a Run.
- **P11-TASK-EVENT** The Surface renders the board and emits `task.actionSubmitted` through the §6.1 mediated source Operation and Receipt causality.
- **P11-TASK-CYCLE-REJECTION** A cycle-forming `update` rejects.
- **P11-TASK-RUN-REFERENCE** A Task's Run relation is a reference.
- **P11-TASK-NO-RUN-COPY** A Task never copies Run state.
- **P11-TASK-PRODUCT-LIFECYCLE** Products MAY define a status lifecycle in their Task Facet schema.
- **P11-TASK-NO-BASE-LIFECYCLE** The base profile defines no Task status lifecycle.

### 11.5 Web

- **P11-WEB-FETCH** Operation `fetch` has `externalSend` impact because the request crosses the trust boundary.
- **P11-WEB-SEARCH** Operation `search` has `externalSend` impact.
- **P11-WEB-CACHED** Reading a cached response has `observe` impact.
- **P11-WEB-URL-SAFETY** SSRF and allowlist policy is enforced before the request leaves.
- **P11-WEB-CREDENTIAL-POLICY** Credential policy is enforced before the request leaves.
- **P11-WEB-LIMIT-POLICY** Rate and size limits are enforced before the request leaves.
- **P11-WEB-DISALLOWED** No request reaches a disallowed host.
- **P11-WEB-CREDENTIAL-ATTACHMENT** Credentials attach only under credential policy.
- **P11-WEB-BOUNDS** Response size and rate are bounded.
- **P11-WEB-BLOCK** A blocked request denies rather than truncates.

### 11.6 MCP

- **P11-MCP-ADAPTER** MCP is an adapter Facet.
- **P11-MCP-TOOLS** Discovered MCP tools become Operations.
- **P11-MCP-RESOURCES** Discovered resources become Operations whose impact the host derives the same way: reading one from a remote server is `externalSend`, and only a platform-side cached projection of a completed read is `observe`.
- **P11-MCP-PROMPTS** Discovered prompts become prompt contributions.
- **P11-MCP-SCHEMA-BOUNDARY** Tools, resources, and prompts are schema-validated at discovery.
- **P11-MCP-LIFECYCLE** MCP start, health, and stop are the Facet lifecycle.
- **P11-MCP-REVISION** The profile targets exact MCP protocol revision `2025-11-25`; any other negotiated revision rejects discovery.
- **P11-MCP-PROMPT-COUNT** A server contributes at most 32 prompt items per discovery.
- **P11-MCP-PROMPT-BYTES** The canonical UTF-8 encoding of all contributed prompt titles and bodies is at most 262144 bytes per discovery.
- **P11-MCP-POSITIVE-BOUNDS** Both MCP prompt maxima are positive, finite, and enforced before materialization.
- **P11-MCP-INVOCATION** An MCP tool call is an ordinary Invocation.
- **P11-MCP-IMPACT-ANNOTATION** Tool `_meta["io.agent-core/impact"]` is a claim by the discovered server, so the host applies it only when it does not lower the §7.2 enforcement floor of the impact the host derived under `C13-FACET-IMPACT-BOUNDARY` (§7.1); otherwise the derived impact stands.
- **P11-MCP-IMPACT-UNKNOWN** An annotation value outside the closed `Impact` set rejects discovery.
- **P11-MCP-IMPACT-DEFAULT-REMOTE** A remote tool's host-derived impact is `externalSend`.
- **P11-MCP-IMPACT-DEFAULT-LOCAL** A local tool's host-derived impact is `execute`.
- **P11-MCP-MALFORMED-SCHEMA** A malformed tool schema rejects at discovery.
- **P11-MCP-NO-LATE-SCHEMA** Schema rejection does not wait until call time.

### 11.7 Approval gateway

- **P11-APPROVAL-GATEWAY-OBSERVE** Operation `observe` reads the credential-holding external resource, so it has `externalSend` impact; only a platform-side cached projection of a completed read is `observe`.
- **P11-APPROVAL-GATEWAY-APPLY** Operation `applyAction` has `externalSend` impact and is always mediated.
- **P11-APPROVAL-GATEWAY-PROVIDER** The gateway's manifest admits `provider` only, so §9.2 can select nothing else for it; it mediates a credential-holding external resource.
- **P11-APPROVAL-GATEWAY-READS** Observations are authorized reads.
- **P11-APPROVAL-GATEWAY-CONTINUATION** Actions are whole-intent-digest-bound Invocations through the invocation-level approval continuation.
- **P11-APPROVAL-GATEWAY-RECEIPTS** The gateway persists canonical Receipts.
- **P11-APPROVAL-GATEWAY-RECONCILIATION** The gateway reconciles indeterminate outcomes under §7.4.
- **P11-APPROVAL-GATEWAY-SURFACE** The gateway contributes an approval Surface.
- **P11-APPROVAL-GATEWAY-CREDENTIAL** Raw credentials never enter the agent domain.
- **P11-APPROVAL-GATEWAY-MATCH** `applyAction` runs only against an approved, matching PreparedInvocation and persisted continuation.

### 11.8 Self

- **P11-SELF-CHECKPOINT** Operation `checkpoint` has `mutate` impact.
- **P11-SELF-COMMIT-MESSAGE** Operation `commitMessage` has `mutate` impact.
- **P11-SELF-SPAWN** Operation `spawn` has `delegate` impact.
- **P11-SELF-FINISH** Operation `finish` has `mutate` impact.
- **P11-SELF-PROPOSE-MIGRATION** Operation `proposeMigration` has `administer` impact.
- **P11-SELF-COMPOSITION** Self is a Facet plus Operations over L2.
- **P11-SELF-SPAWN-MEMBRANE** Spawning child Runs flows through the Invocation membrane.
- **P11-SELF-FINISH-MEMBRANE** Finishing flows through the Invocation membrane.
- **P11-SELF-AUTHORITY** Self lifecycle actions receive normal authority checks.
- **P11-SELF-RECEIPTS** Self lifecycle actions receive canonical Receipts.
- **P11-SELF-AUDIT** Self lifecycle actions receive audit evidence.
- **P11-SELF-ATTENUATION** `spawn` creates a child Run under attenuated Grants and, when one is declared, an attenuated `ResourceCeiling` (§5.2).
- **P11-SELF-LEASE** Every Self Operation is lease-fenced.
- **P11-SELF-NO-WIDENING** A spawned child's authority does not exceed its parent's authority.
- **P11-SELF-MEDIATION** No Self Operation bypasses mediation.

### 11.9 Environment

- **P11-ENVIRONMENT-SPECIFICATION** The Environment profile is specified with §4.5.
- **P11-ENVIRONMENT-OPEN** The base Session lifecycle includes open.
- **P11-ENVIRONMENT-USE** The base Session lifecycle includes use.
- **P11-ENVIRONMENT-CLOSE** The base Session lifecycle includes close.
- **P11-ENVIRONMENT-CHILD-FACETS** Child Facets are Session-scoped.
- **P11-ENVIRONMENT-ROTATION** Rotation does not retarget open Sessions.
- **P11-ENVIRONMENT-SNAPSHOT** A conforming Environment profile specifies snapshot and restore.
- **P11-ENVIRONMENT-EPHEMERAL-DURABILITY** It specifies ephemeral-filesystem durability.
- **P11-ENVIRONMENT-PREVIEW** It specifies an authenticated preview URL per exposed port.
- **P11-ENVIRONMENT-CREDENTIAL-SEAM** It specifies the credential-isolation seam.
- **P11-ENVIRONMENT-NO-AMBIENT-EGRESS** A Session starts with no network reach of its own; every destination its child Facets can address arrives as an explicitly passed Binding, so code written inside the Session cannot route around the outbound policy its `externalSend` Operations enforce.
- **P11-ENVIRONMENT-NO-BASE-OPERATIONS** The base profile declares no Operations.
- **P11-ENVIRONMENT-NO-BASE-EVENTS** The base profile declares no Events.
- **P11-ENVIRONMENT-CHILD-CONTRACTS** Session child Facet profiles declare their own Operations, Events, and impacts.
- **P11-ENVIRONMENT-FAIL-CLOSED** A stale Session fails closed.
- **P11-ENVIRONMENT-DISPOSE** Closing a Session disposes its child Facets.

### 11.10 Device

- **P11-DEVICE-CAMERA** Operation `camera` has the versioned input `{ deviceId: string, arguments: { facing: "front" | "rear" } }` with no additional properties.
- **P11-DEVICE-LOCATION** Operation `location` has the versioned input `{ deviceId: string, arguments: { accuracyMeters?: nonnegative number } }` with no additional properties.
- **P11-DEVICE-SMS** Operation `sms` has the versioned input `{ deviceId: string, arguments: { to: nonempty string, message: nonempty string } }` with no additional properties.
- **P11-DEVICE-SCREEN** Operation `screen` has the versioned input `{ deviceId: string, arguments: { mode: "capture" | "stream" } }` with no additional properties.
- **P11-DEVICE-SYSTEM-RUN** Operation `system.run` has the versioned input `{ deviceId: string, arguments: { command: nonempty string, arguments?: string[] } }` with no additional properties.
- **P11-DEVICE-ENVIRONMENT** Device is an Environment behind a reverse-connection transport.
- **P11-DEVICE-PAIRING** Pairing requires key exchange and operator approval.
- **P11-DEVICE-CONSENT-PAIR** Consent is transport-attached, exact per device and Agent, and fail-closed.
- **P11-DEVICE-TYPED-SURFACE** Device exposes a typed command Surface.
- **P11-DEVICE-LIVE-IMPACT** Every live device request has `externalSend` impact.
- **P11-DEVICE-CACHED-READ** Operation `readCached` has `observe` impact and versioned input `{ deviceId: nonempty string, key: nonempty string }` with no additional properties.
- **P11-DEVICE-NO-PROFILE-EVENTS** The profile declares no profile-specific Events.
- **P11-DEVICE-COMMAND-EVENTS** Command exposure uses standard `command.invoked` and `command.completed` Events with §6.1 Receipt causality.
- **P11-DEVICE-CONSENT-LIVE** A device command executes only under live consent for its exact pair.
- **P11-DEVICE-CONSENT-ABSENT** Absence of consent denies before an EffectAttempt.
- **P11-DEVICE-CONSENT-FINAL-CHECK** The target performs the final exact-pair consent check immediately before EffectAttempt admission.
- **P11-DEVICE-CONSENT-REVOCATION** Consent revocation committed before that final check denies without an EffectAttempt.
- **P11-DEVICE-CONSENT-ADMITTED** Revocation does not cancel an external effect already admitted by an EffectAttempt.
- **P11-DEVICE-CONSENT-ISOLATION** One device's consent never authorizes another device.
- **P11-DEVICE-SCHEMA-VERSION** All six Device Operation input schemas are codec-versioned and follow §8.3.

### 11.11 Slate

- **P11-SLATE-UPDATE** Operation `update` has `mutate` impact on the Slate record.
- **P11-SLATE-COMMIT** Operation `commit` has `mutate` impact on the Slate record.
- **P11-SLATE-FORK** Operation `fork` has `mutate` impact on the Slate record.
- **P11-SLATE-PUBLISH** Operation `publish` has `mutate` impact on the Slate record.
- **P11-SLATE-DEPLOY** Operation `deploy` has `externalSend` impact.
- **P11-SLATE-ROLLBACK** Operation `rollback` has `mutate` impact.
- **P11-SLATE-SPECIFICATION** The Slate profile is specified with §4.6.
- **P11-SLATE-SOURCE** Source is content-addressed with immutable version history.
- **P11-SLATE-DYNAMIC** The backend's manifest admits `dynamic` only, so §9.2 selects a `dynamic` domain for it, and §1.5's zero-ambient-authority and zero-ambient-egress rules apply to it as to any other `dynamic` domain.
- **P11-SLATE-PREVIEW** Live preview is an Environment Session.
- **P11-SLATE-IMMUTABLE-PUBLICATION** A published version is immutable.
- **P11-SLATE-MEDIATED-DEPLOY** `deploy` is a mediated Invocation.
- **P11-SLATE-BINDINGS** The backend receives capabilities only through explicitly passed Bindings.
- **P11-SLATE-ROLLBACK-POINTER** `rollback` atomically changes the active pointer to an existing successful deployment owned by the same Slate and does not contact a provider.
- **P11-SLATE-ROLLBACK-NO-DEPLOY** Applying a new or prior version to an external provider is `deploy`, not `rollback`, and retains `externalSend` impact.

### 11.12 Single-tenant

- **P11-SINGLE-TENANT-POLICY** Single-tenant is a policy profile.
- **P11-SINGLE-TENANT-NO-MACHINERY** It introduces no new machinery.
- **P11-SINGLE-TENANT-PRINCIPAL** It has one Principal.
- **P11-SINGLE-TENANT-TENANT** It has one Tenant.
- **P11-SINGLE-TENANT-OWNER** Policy auto-grants an `owner` Membership as a trusted-operator default.
- **P11-SINGLE-TENANT-RECORDS** The ordinary Grant and Binding records still exist.
- **P11-SINGLE-TENANT-PROMOTION** Policy change can promote the platform to multi-tenant without rewriting records.
- **P11-SINGLE-TENANT-ASSEMBLY** A personal assistant is a policy choice rather than a different architecture.
- **P11-SINGLE-TENANT-NO-OPERATIONS** The profile declares no Operations.
- **P11-SINGLE-TENANT-NO-EVENTS** The profile declares no Events and no impacts.

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
Slate-like resource; shadow evaluation runs as child Runs spawned under attenuated
Grants and ResourceCeilings (§5.2); promotion is a mediated `administer` Invocation.
The primary calling convention is programmatic tool calling (§4.7): one code
submission per tool call, capabilities passed as Bindings, in-Session writes on
§7.2's Turn-owned floor, results returnable as handles (§5.6). One thing the real
system does that these primitives deliberately do not capture: it amortizes admission
across a whole code execution, performing hundreds of boundary-crossing effects with
no per-effect admission, where here every `externalSend` and every non-Session
`mutate` pays its own mediated pipeline and §7.3 batching amortizes only homogeneous
items of one Operation. A rebuild on these primitives keeps per-effect evidence and
pays that cost knowingly.

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

**Mixture-of-agents orchestration.** Proposer Turns use sibling branches from one
parent commit; an aggregator Turn reads two sibling heads and produces synthesis
content under an exact LeaseToken and successful `execute` Receipt. After a matching
`administer` control Receipt succeeds, a system writer appends the binary merge. More
proposers are folded in caller-supplied order. A judge Turn writes a verdict commit;
fan-out is `delegate`-impact spawning under attenuated Grants.

---

## 13. Conformance

The bold labels below are the stable atomic conformance map for binding prose in §§1.4–1.5,
§§2–10, and §13. Repeated explanations and cross-references map to the same concept
label rather than creating duplicate requirements; modified clauses carry an inline
map where their primary atom would otherwise be ambiguous. Every §11 atom carries its
own authoritative `P11-*` label. Label order has no semantic meaning.

A conforming implementation provides:

- **C13-AUTH-SCOPE-DIRECTION** Authority and declared policy resolve downward along the Scope chain, while a composition record belongs to exactly the Scope holding it and an Event is matched only by its accepting Actor's Subscriptions.
- **C13-AUTH-PLANE** One durable allow/deny Grant plane.
- **C13-AUTH-ROLE-MATERIALIZATION** Idempotent Role-rule materialization.
- **C13-AUTH-DENY-PATH** The `AuthorityService.deny` path.
- **C13-AUTH-BINDING-RESOLUTION** Binding-only resolution, and a Binding authorizes only its own Facet's Operations.
- **C13-AUTH-DENY-PRECEDENCE** Deny-overrides precedence.
- **C13-AUTH-DIRECT-SUBJECT** Direct Principal authority cases.
- **C13-AUTH-TEAM-SUBJECT** Team-derived authority cases.
- **C13-AUTH-GUEST-SUBJECT** Guest authority cases.
- **C13-AUTH-GUEST-ELEVATION** The guest elevation prohibition.
- **C13-AUTH-GUEST-VERIFICATION** The host verifies a guest's provenance by one of the three declared schemes before materializing any Grant, and a failure denies.
- **C13-AUTH-GUEST-HANDSHAKE-BOOTSTRAP** `handshake` is a bootstrap scheme that materializes no Grant itself, and a subject still stamped `handshake` at materialization is denied.
- **C13-AUTH-PRINCIPAL-REF** Security-sensitive Principal references are tenant-qualified and exact-matched.
- **C13-AUTH-PATH-EVIDENCE** Complete Tenant-to-target PathEpochEvidence.
- **C13-AUTH-EPOCH-ADVANCEMENT** Path epoch advancement for allow and deny changes.
- **C13-AUTH-PATH-ORDER** Path evidence in exact order and with no extra Scopes.
- **C13-AUTH-WATERMARK-MONOTONE** Monotonic delivered invalidation watermarks.
- **C13-AUTH-DIRECT-LEASE** Direct admission requires the exact current LeaseToken.
- **C13-AUTH-DIRECT-DEADLINE** Direct admission requires a deadline derived from the original lease expiry.
- **C13-AUTH-DIRECT-WATERMARK** Direct admission requires an unstaled watermark.
- **C13-AUTH-MEDIATED-STALE** A mediated stale comparison atomically advances the watermark before recording pre-effect denial.
- **C13-AUTH-MEDIATED-ADMISSION** Cross-DO permit issuance after exact claim identity is the final authority-admission linearization point.
- **C13-AUTH-RESOLUTION-LIFETIME** A `bundled` resolution expires with its Turn and deadline; a `provider` or `dynamic` resolution lasts one Turn step and re-resolves against current path epochs.
- **C13-AUTH-ISOLATE-DELEGATION** A capability passed into a `dynamic` isolate is a delegation bounded by the §3.4 rules, and the isolate's Invocations present its own delegated authority, never its loader's.
- **C13-PLACEMENT-INTERSECTION** Deterministic placement by admissible-set intersection over manifest, policy, substrate, and trust sets.
- **C13-PLACEMENT-ORDER** Placement uses the one fixed preference order.
- **C13-PLACEMENT-EMPTY** An empty placement intersection is rejected.
- **C13-PLACEMENT-UNTRUSTED-BUNDLED** Untrusted placement excludes `bundled`.
- **C13-PLACEMENT-DYNAMIC-NO-EGRESS** A `dynamic` domain starts with no ambient network reach; every destination arrives as an explicitly passed Binding.
- **C13-PLACEMENT-AUTHORED-BACKING** A platform declares which backing hosts each agent-authored code consumer, and every offered backing preserves identical `dynamic` authority semantics.
- **C13-POLICY-DIRECT-COLOCATION** The `direct`-tier co-location requirement is enforced.
- **C13-POLICY-DIRECT-ESCALATION** A direct call that cannot be co-located escalates to `mediated` (§7.2).
- **C13-POLICY-MEDIATION-FLOOR** No policy can make `externalSend`, `delegate`, `administer`, `execute` outside a Turn-owned Session, or `mutate` outside that Session's own filesystem direct.
- **C13-POLICY-APPROVAL-FLOOR** No policy can remove mandatory approval.
- **C13-POLICY-EPOCH-RECHECK** Every mediated effect performs the current-epoch check.
- **C13-CONFIG-SECRET-REF** Configuration is SecretRef-only, with no raw credentials in manifests or Blueprints.
- **C13-CONFIG-SECRET-CUSTODY** A SecretRef resolves only inside its owning Tenant and only for the recorded Binding and target; delegation carries the ref, never the value.
- **C13-FACET-MANIFEST** Facet manifests are implemented.
- **C13-FACET-REF-CANONICAL** Every FacetRef uses the one canonical `<facet-package-id>:<instance>` identity.
- **C13-FACET-CONTRIBUTION-MATERIALIZATION** Facet contributions materialize through the specified primitive paths.
- **C13-FACET-SLOT-AUTHORITY** Slot contribute-authority is enforced.
- **C13-FACET-SLOT-VISIBILITY** `SlotCatalog.query` is viewer-filtered.
- **C13-FACET-DISPOSAL** A Turn disposes its resolved Facets on completion, failure, cancellation, suspension, or authority loss.
- **C13-FACET-INSTALL-VERIFICATION** Install-time verification requires every implementation the manifest declares and refuses a contribution it does not declare.
- **C13-FACET-IMPACT-BOUNDARY** The host derives an operation's impact from the seam its request crosses, never from a declaration by the callee.
- **C13-FACET-WITHDRAWAL-EXACT** Withdrawal is an `administer` Operation that retires exactly the withdrawing Facet's attributed records, its Bindings and solely-naming Grants, and its Slot declarations, never append-only evidence and never another Facet's entries.
- **C13-FACET-CONTRIBUTION-ATTRIBUTION** Every materialized contribution record carries the contributing `FacetRef` and the source `PackagePin`, written in the same transaction and immutable thereafter.
- **C13-FACET-WITHDRAWAL-DRAIN** A withdrawal does not complete while an admitted Invocation item naming the withdrawing Facet lacks a terminal current Receipt.
- **C13-FACET-START-ATOMIC** A Facet whose `start` does not complete contributes nothing, and the host retires the partial activation through the same attributed withdrawal set.
- **C13-FACET-DEPENDENCY-ORDER** A Facet starts only once every `BindingRequirement` resolves, a Facet an active Facet's resolved requirement names is relied upon so its withdrawal is held as a pending obligation, and a withdrawing Facet keeps resolving its own requirements throughout its teardown.
- **C13-FACET-CAPABILITY-ABSENCE** A capability a manifest withholds is the declaration's absence rather than a present negative value, and a present negative form is refused at install.
- **C13-FACET-CODE-AVAILABILITY** An Operation's availability to agent-authored code is declared per contribution, is native-only when absent, bounds the Bindings an isolate receives, and rejects the Blueprint at validation when the platform maps no backing to serve it.
- **C13-COMMAND-ARGUMENT-BINDING** The Command lifecycle performs argument binding (§4.3).
- **C13-COMMAND-INSTALL-MAPPING** Command mapping validates at install.
- **C13-COMMAND-SUBSCRIPTION-DEFAULTS** Derived Subscription defaults are deterministic.
- **C13-COMMAND-COLLISION** Command collisions are rejected.
- **C13-COMMAND-COMPLETION-IMPACT** A command's `completion` Operation carries `observe` impact, so argument completion never leaves the direct tier.
- **C13-COMMAND-INVOCATION-CORRELATION** `Event(command.invoked)` correlation carries the originating SurfaceId and, from a conversation, the RunRef and branch, and the derived Subscription admits no inferred compatibility relation or alternate authority source.
- **C13-COMMAND-RESULT** Command results are delivered as correlated `command.completed` Events.
- **C13-INTERCEPTOR-DOMAIN-CONFINEMENT** Interception happens only within one protection domain, and crossing one uses asynchronous Events.
- **C13-INTERCEPTOR-POST-PREPARATION** No interceptor rewrites a PreparedInvocation, Approval, EffectAttempt, or effect arguments after preparation.
- **C13-INTERCEPTOR-ORDER** Interceptors order by `(mode, priority, facetId, interceptorId)`, and a declared mode dominates local priority.
- **C13-INTERCEPTOR-MODE-DECLARED** An interceptor declares its mode, and an absent or unknown mode is refused rather than defaulted.
- **C13-INTERCEPTOR-MODE-FIDELITY** A `gate` interceptor never rewrites the value it received.
- **C13-INTERCEPTOR-SELF-SCOPE** Interceptors default to self-scope.
- **C13-INTERCEPTOR-CROSS-FACET** Cross-facet interception is opt-in.
- **C13-INTERCEPTOR-ATTRIBUTION** Pre-preparation rewrites are attributable.
- **C13-INTERCEPTOR-FROZEN-RETRY** Retrying a frozen intent does not rerun mutating interceptors.
- **C13-INTERCEPTOR-REPLAY** Replay persists and reuses both pre-effect and post-effect interceptor transformations and traces.
- **C13-INTERCEPTOR-THROW-BLOCK** A thrown interceptor error is a scoped block.
- **C13-ENVIRONMENT-STALE-SESSION** Environment session lifecycle rejects a stale session.
- **C13-ENVIRONMENT-DISPOSE-CLOSE** Environment session close disposes child Facets.
- **C13-ENVIRONMENT-ROTATION** Environment rotation does not retarget open Sessions.
- **C13-ENVIRONMENT-TURN-OWNED** A Turn-owned Session is opened by exactly one Turn, usable under no other Turn's lease, and closes when its owning Turn reaches a terminal status.
- **C13-TRUST-HOST-DERIVED** Trust tiers are host-derived.
- **C13-TRUST-ASSERTION-REJECTION** Tier-asserting sources are rejected.
- **C13-TRUST-VERIFIED-INGRESS** Verified ingress mints Events.
- **C13-PROFILE-SOURCE-EVENT-CAUSALITY** Standard profile source Events are caused by the exact successful host-Operation Receipt.
- **C13-SUBSCRIPTION-ACCEPTED-TIERS** Subscriptions have explicit accepted-tier sets.
- **C13-SUBSCRIPTION-AUTHORITY** Subscriptions use initiator or explicit delegated authority.
- **C13-ROUTE-SOURCE-OWNED** RouteReservations are source-owned and authenticated.
- **C13-ROUTE-STABLE-INVOCATION** RouteReservations carry a stable InvocationId.
- **C13-ROUTE-SOURCE-EVENT** RouteReservations name their source Event.
- **C13-ROUTE-AUDIT-CAUSE** RouteReservations name their audit cause.
- **C13-ROUTE-PROJECTION-DIGEST** RouteReservations authenticate their projection digest.
- **C13-ROUTE-TENANT-RELATION** RouteReservations authenticate their tenant relation.
- **C13-ROUTE-CROSS-TENANT-BINDING** Cross-tenant RouteReservations authenticate their Binding.
- **C13-ROUTE-DELIVERY-ONCE** A reservation has at most one terminal RouteDelivery and it is written once; redelivery returns it.
- **C13-PREPARED-SHARED-HEADER** PreparedInvocation uses one shared header.
- **C13-PREPARED-OPTIONAL-LEASE** The shared header carries an optional exact LeaseToken.
- **C13-PREPARED-PAYLOAD-SHAPE** Payload is exactly single or nonempty ordered homogeneous batch.
- **C13-PREPARED-ITEM-KEYS** Per-item idempotency keys are derived from the complete specified identity.
- **C13-PREPARED-WHOLE-DIGEST** Whole-intent digesting is canonical and structural.
- **C13-PREPARED-REPLAY-IDENTITY** Mediated replay keys bind caller, request key, raw payload identity, target pin, lease, and route before interceptors.
- **C13-PREPARED-REPLAY-PRE** Matching mediated replay reuses exact ordered per-item pre-effect transformations and prepared arguments.
- **C13-PREPARED-REPLAY-POST** Matching batch replay preserves item-indexed output association while reusing exact per-item post-effect transformations and presentations; direct writes no replay record.
- **C13-PREPARED-ROUTED-PROJECTION** Routed preparation obeys the exact projection rules.
- **C13-PREPARED-NO-TURN-OWNER** No-Turn mediation authenticates the domain owner.
- **C13-PREPARED-NO-TURN-AUDIT** No-Turn mediation requires a preexisting local audit cause.
- **C13-PREPARED-APPROVAL-BINDING** Approval binds to the PreparedInvocation.
- **C13-PREPARED-APPROVAL-SINGLE-USE** Approval is invocation-level and single use.
- **C13-PREPARED-APPROVAL-UNIQUE** At most one Approval exists per Invocation.
- **C13-PREPARED-CONTINUATION-ABSENT** Invocation continuation is absent before first Approval consumption.
- **C13-PREPARED-APPROVAL-FIRST-ATTEMPT** Approval consumption is atomic with the first admitted EffectAttempt and persisted continuation.
- **C13-PREPARED-APPROVAL-CONTINUATION** Where an Approval was required, later batch items and retries validate that the exact first EffectAttempt belongs to the continuation Invocation and PreparedInvocation item without consuming another Approval; where none was required, no continuation exists.
- **C13-RECEIPT-PRE-EFFECT** Terminal pre-effect Receipts are distinct from attempted Receipts.
- **C13-EFFECT-ATTEMPT-IMMUTABLE** EffectAttempts are immutable.
- **C13-RECEIPT-ATTEMPT-CHAIN** Attempted Receipts form the specified attempt chains.
- **C13-RECEIPT-ID-NAMESPACE** All Receipt kinds share one ReceiptId namespace.
- **C13-CLAIM-INITIAL-ATOMIC** Initial item claims are atomic.
- **C13-CLAIM-FUTURE-EXPIRY** Item claims require a future expiry.
- **C13-CLAIM-RECOVERY-NO-ATTEMPT** Recovery is permitted only for an expired claim with no attempt.
- **C13-CLAIM-RECOVERY-NEW-OWNER** Recovery uses a new owner.
- **C13-CLAIM-RECOVERY-FUTURE-EXPIRY** Recovery records a new future expiry.
- **C13-CLAIM-RECOVERY-SAME-ORDINAL** Recovery retains the same attempt ordinal.
- **C13-ATTEMPT-ORDINAL-AFTER-FAILURE** A new attempt ordinal appears only after final failure.
- **C13-RECEIPT-INDETERMINATE-SUPERSESSION** Indeterminate supersession follows the exact lineage rules.
- **C13-RECEIPT-IMMUTABLE** Attempts and Receipts are never updated or deleted, and only an indeterminate chain head is superseded, exactly once, and never a final Receipt.
- **C13-RECEIPT-FAILURE-KIND** A `failed` AttemptReceipt names exactly one kind from the closed set `raised`, `deadline`, `aborted`, `domainLost`, and `outputInvalid`, no other Receipt outcome names one, and only `raised` originates with the invoked handler.
- **C13-RECEIPT-FAILURE-ORTHOGONAL** A failure kind is recorded only on an attempted `failed` outcome, never substitutes for the pre-effect Receipt variant or for `indeterminate`, and changes no outcome, supersession lineage, retry eligibility, or admission decision.
- **C13-BATCH-OUTCOME-COMPLETE** BatchOutcome exists only after every item has a current Receipt.
- **C13-BATCH-OUTCOME-TERMINAL** A terminal aggregate exists only when no current outcome is indeterminate.
- **C13-EFFECT-WRITE-AHEAD** Effect evidence is written before the external effect.
- **C13-EFFECT-IDEMPOTENCY** Idempotency keys propagate to the provider effect.
- **C13-EFFECT-RECONCILIATION** Indeterminate effects reconcile by the specified attempt identity.
- **C13-EFFECT-SUPERSEDING-RECEIPT** Reconciliation obeys superseding Receipt rules.
- **C13-EFFECT-RECONCILIATION-DRIVER** Reconciliation has a named driver.
- **C13-AUDIT-APPEND-ONLY** Typed audit chains are append-only.
- **C13-AUDIT-PREEXISTING-CAUSE** Audit causes preexist.
- **C13-AUDIT-RECEIPT-OUTCOMES** Every Receipt outcome has an AuditRecord.
- **C13-AUDIT-SYSTEM-WRITER** System-writer causes are audited.
- **C13-AUDIT-EDGE-RELATION** Audit chains enforce the exact permitted edge relation.
- **C13-AUDIT-ROUTE-BRIDGE** Source-owned RouteReservation bridges are the only cross-Actor audit bridge.
- **C13-AUDIT-SETTLED-OBLIGATION** Settled audit obligations resolve to their exact captured evidence.
- **C13-AUDIT-TELEMETRY-EXCLUDED** Telemetry never substitutes for a Receipt, RouteReservation, WriteRecord, or AuditRecord.
- **C13-RUN-GRAPH-ARITY** The canonical Run graph enforces every parent arity, including that a merge has exactly two ordered parents.
- **C13-RUN-GRAPH-CLOSED** Every RunCommit names the one Run it belongs to and every parent it names, including both merge parents, is a commit of that same Run, so a Run's ancestry holds nothing the Run did not author and another Run's material enters only as the content of a commit the Run appended.
- **C13-RUN-BINARY-TREE-MERGE** Tree merge is binary.
- **C13-RUN-UNDO-REDO** Undo and redo are append-only selection.
- **C13-RUN-UNDO-FENCE** Undo fences a held Turn before appending, regardless of lease expiry.
- **C13-RUN-EFFECTIVE-TRANSCRIPT** A branch's effective transcript is derived from committed records — the effective state's ancestry with every commit a rewrite commit's `shadows` field names omitted and that rewrite's content read where they stood — and a shadowed commit stays reachable, immutable, and retained.
- **C13-RUN-REWRITE-BRACKET** A rewrite reserves its planned `RunCommitId` as a `systemCommit` obligation that excludes a second uncompleted rewrite on the same branch, and closes by appending that exact commit either as an installed rewrite on a successful `administer` Receipt or as an abandoned one on that attempt's failed Receipt which shadows nothing.
- **C13-RUN-CUT-BALANCE** Every cut — an undo's selection, a branch created below a head, a rewrite's shadow set — leaves a transcript in which each retained request keeps its `invocation` commit and each retained `invocation` commit keeps the request it answers, and a `message` commit names the Invocations its content requests.
- **C13-RUN-ANCESTRY** Run storage supports ancestry queries.
- **C13-WRITER-MATRIX** Run commits enforce the exact root/Turn/system CommitWriter matrix.
- **C13-WRITER-POST-FENCE-EVIDENCE** Receipt and delivery evidence may complete after fencing only as specified.
- **C13-WRITER-SYSTEM-MERGE** Merges are system-authored by successful control Receipts.
- **C13-WRITER-SYNTHESIS** Synthesis records exact-token successful execute evidence.
- **C13-RUN-PINS-IMMUTABLE** RunPins are immutable.
- **C13-RUN-PINS-BLUEPRINT** RunPins include the exact Blueprint version and digest.
- **C13-RUN-PINS-PACKAGES** RunPins include the complete Package closure.
- **C13-RUN-PINS-SOURCES** RunPins identify exact Blueprint, Agent, effective PolicySet, and ModelPolicy source identities and digests.
- **C13-RUN-PINS-ENVIRONMENT** RunPins identify exact Environment id, revision, and digest and keep every pinned source resolvable.
- **C13-RUN-PINS-VALIDITY** RunPins bind Run.agent and a nonempty Package closure unique by PackageId.
- **C13-RUN-PIN-IDENTITY-TYPES** `PackageId` and `FacetPackageId` are distinct opaque identities and are never converted or compared by string value.
- **C13-RUN-CHECKPOINT-KINDS** Run checkpoints and tree checkpoints are distinct records and are never conflated.
- **C13-RUN-TREE-CONFLICT-EXPLICIT** A path changed on both sides is surfaced, no merge commit is appended while any tree conflict is unresolved, and the explicit side for each conflict comes from the operator or an `administer`-impact Operation and is recorded in the merge.
- **C13-RUN-PARENT-PIN-INHERITANCE** Every non-migration unary commit inherits exact parent pins.
- **C13-RUN-MIGRATED-TURN-REJECTION** A Turn retaining pre-migration pins cannot terminalize a migrated Run.
- **C13-RUN-PLACEMENT-SNAPSHOT** Each Turn has a separate immutable placement snapshot.
- **C13-RUN-EQUAL-PIN-MERGE** Merge admission requires equal pins.
- **C13-RUN-EXPLICIT-MIGRATION** Run migration is explicit, durably evidenced, and rejects invalid target RunPins before installation.
- **C13-RUN-ADMISSION-REGISTRY** Every Run-associated asynchronous obligation uses canonical pre-remote identity reserve, completion, and close transitions in the Run-owner registry.
- **C13-RUN-RESERVATION-EPOCH** Remote admission validates the exact reserved identity and open Run registry epoch.
- **C13-RUN-ACCEPTANCE-OBLIGATION** A declared acceptance criterion is a reserved Run obligation that only a succeeded verifier Receipt discharges, and declaring none changes nothing.
- **C13-RUN-ACCEPTANCE-SUBJECT** An acceptance verdict is evidence for its exact subject digest, and a further attempt requires a subject no recorded verdict names.
- **C13-RUN-RESOURCE-CEILING** A spawned Run's declared resource ceiling never exceeds its parent's remainder in any declared dimension, an undeclared dimension inherits that remainder, and declaring none bounds nothing.
- **C13-RUN-CEILING-EXHAUSTION** An exhausted ceiling cancels the Run through the ordinary §5.3 terminal rows, naming the exhausted dimension only when that dimension has no allowance left.
- **C13-RUN-CEILING-REMAINDER** `depth` and `wallClockMs` remainders are derived from the spawn lineage and the root RunCommit timestamp rather than separately accounted, and `tokens` is a durable per-Run running total accumulated where a model call commits.
- **C13-RUN-CEILING-COST** `costMicros` is a durable per-Run running total of realized model cost accumulated where a model call commits, never an estimate, recorded in one currency per Run lineage, with the rate source outside this document's scope.
- **C13-RUN-TERMINAL-SIBLINGS** Run terminalization closes only after every sibling Turn is terminal and unheld.
- **C13-RUN-FORCED-CANCELLATION** Forced cancellation is terminalization-only, distinct-sibling, administer-authorized fencing and cancellation evidence without Turn impersonation.
- **C13-RUN-TERMINAL-OBLIGATIONS** Run terminalization captures a finite obligation set.
- **C13-RUN-FRONTIER-COMPLETE** The terminal snapshot captures exactly reserved-minus-completed obligations with no omissions or extras.
- **C13-RUN-FRONTIER-EMPTY** An honestly empty admitted unfinished frontier is valid.
- **C13-RUN-SETTLED-DERIVED** Settled is derived from captured obligations, including exact Approval and reconciliation lineage discharge.
- **C13-TURN-ADMISSION-HANDLE** An executor may return a mediated Invocation's admission identity in the model's tool position without changing admission, and a spawn's `delegate` Receipt carries the child RunRef, never the child's result.
- **C13-TURN-CANCEL-INBOX** Mid-turn delivery appends to the running Turn's lease-fenced inbox, cancellation is the reserved `turn.cancel` Event, and a conforming executor observes it between steps and stops committing.
- **C13-TURN-EXACT-LEASE** Turn leases are exact-Turn.
- **C13-TURN-FACET-SET-STABLE** A Turn's FacetSet is exactly the refs its immutable TurnPlacementSnapshot names and its membership does not change for the Turn's lifetime, while capture fixes membership only: every use of a member re-authorizes under §3.4, so a Grant revoked mid-Turn severs the capability without changing the set the Turn composes.
- **C13-TURN-LEASE-EXPIRY** Every lease claim, renew, or reclaim requires a future `expiresAt`, and reclaim additionally requires the recorded expiry to be at or before now.
- **C13-TURN-MODEL-CALL** A model call happens only inside a Turn.
- **C13-TURN-MODEL-INPUT-RECONSTRUCTABLE** The executor seam exposes a reconstruction that yields a model call's exact request — assembled prompt sections in final order, the operation catalog as offered, and every inbox Event admitted before the call — from records the Turn has already committed, inline or by `ContentRef`, and the call issues that reconstruction's output rather than a separately assembled value.
- **C13-TURN-MODEL-INPUT-DURABLE-BEFORE-DISPATCH** The records a model call's reconstruction depends on are durable before the call is dispatched, and a rejected, unavailable, or indeterminate commit prevents dispatch rather than proceeding with an unrecorded request.
- **C13-TURN-MODEL-INPUT-RETENTION-LOSS** A reconstruction whose named Event or `ContentRef` is no longer retained fails with a typed error naming what is missing rather than assembling a shorter prefix, a partial request, or a best-effort approximation.
- **C13-TURN-MODEL-INPUT-ABRIDGED** A request carrying less of a result than the record holds records the abridged form itself and states the withheld amount exactly or as unknown, and a host records neither an omission made under a bound as the source's own incompleteness nor an incomplete source as an omission made under a bound.
- **C13-TURN-TRANSCRIPT-RECONSTRUCTION** A model call's reconstruction derives its transcript from the exact commit that call read, so a rewrite appended later is a descendant that cannot enter it, and shadowing supersedes without releasing content an earlier request named.
- **C13-TURN-LIFECYCLE** Turns implement the complete lifecycle table.
- **C13-TURN-NO-RETRY** The closed Turn lifecycle contains no retry transition.
- **C13-TURN-NO-RETRY-RUNTIME** Runtime integration contains no Turn retry operation.
- **C13-TURN-NO-RETRY-PROTOCOL** Protocol integration contains no Turn retry command family.
- **C13-TURN-NO-RETRY-EXPORT** Package integration exposes no Turn retry symbol.
- **C13-TURN-NO-RETRY-RECORD** Record and migration registries contain no Turn retry record or upcast.
- **C13-TURN-EXECUTOR-WRITER** Every executor-authored write — RunCommit, Invocation intent, EffectAttempt, child-Run spawn, callback, checkpoint, and terminal result — rejects stale, expired, wrong-Turn, wrong-holder, and terminal-transition leases.
- **C13-VIEW-NO-LIVE-STATE** Views satisfy the no-live-state invariant.
- **C13-VIEW-DELTA-REPLAY** ViewDelta supports revision replay.
- **C13-VIEW-APPROVAL-PROVENANCE** A decision View marks every value the host did not originate with its TrustTier, names the exact `intentDigest` it authorizes, and its Surface renders a marked value as data rather than as platform voice.
- **C13-VIEW-WITHDRAWAL-TERMINAL** A retired Surface emits one final ViewDelta marking its View terminal and no revision after it, an `EventCursor` presented for a retired Surface returns that terminal revision rather than a resumable stream or an error, and an aggregating Surface drops the retired child's entry at its next revision.
- **C13-CONTENT-RESOLUTION** Every ContentRef resolves through a ContentStore that belongs to exactly one Tenant, and only for a caller whose authority reaches that Tenant.
- **C13-CONTENT-CUSTODY** Every record naming a `ContentRef` retains that content until the record releases it.
- **C13-CODEC-VERSIONING** Every durable record codec satisfies §8.3.
- **C13-PROTOCOL-EXACT-ENVELOPE** The command dispatcher enforces exact caller and optional LeaseToken envelopes.
- **C13-PROTOCOL-FAMILY-ENVELOPE-POLICY** Each command family declares whether `expectedRevision` is required and whether a LeaseToken is required, optional, or forbidden, and a violated declaration is `rejectedMalformed` except for token policy, which is `rejectedLease`.
- **C13-PROTOCOL-OUTCOMES** The command dispatcher produces deterministic complete outcomes.
- **C13-PROTOCOL-DUPLICATE** Duplicate commands return duplicate replies without repeating mutation.
- **C13-PROTOCOL-REJECTION-ROOT** Host rejection roots follow §8.5.
- **C13-PROTOCOL-WRITE-AUDIT-LINK** WriteRecord and AuditRecord evidence are linked.
- **C13-PROTOCOL-ATOMIC-EVIDENCE** Domain decision, WriteRecord, and AuditRecord commit atomically.
- **C13-OWNERSHIP-MAP** Conformance includes the state-ownership map required by §8.4 rule 6.
- **C13-OWNERSHIP-SINGLE-OWNER** Every record type has one owning Actor; other Actors hold only rebuildable indexes and derived caches, and never dual-write.
- **C13-OWNERSHIP-ACTOR-CONTRACT** An Actor serializes conflicting commands, recovers state before serving, commits at declared linearization points, and rejects stale fences.
- **C13-OWNERSHIP-AUTHORITY-RECORDS** The Tenant Actor is the sole durable owner of Binding, Grant, and ScopeEpoch records, a Binding change and its path-epoch advance commit in one Tenant-local control transaction, and other Actors retain no canonical or mirrored copy.
- **C13-BLUEPRINT-VALIDATE-BEFORE-LOAD** Blueprint validation completes before package code loads.
- **C13-BLUEPRINT-REMATERIALIZE** Blueprint re-materialization is idempotent.
- **C13-BLUEPRINT-RUN-PINS** Re-materialization preserves RunPins (§9.3).
- **C13-BLUEPRINT-CONVERGENCE** The Blueprint-managed record set of a converged Scope is a function of the Blueprint alone, strengthening idempotence to independence from issue order and prior state; a host defers only where this document states the deferral and its discharging condition, each deferral is a pending obligation naming its record, reason, and condition, a Scope is converged exactly when the reconciliation outcome's pending set is empty, and a divergence no such obligation expresses is a rejected reconciliation.
- **C13-PACKAGE-DEPENDENCY-DECLARED** A Package declares its inter-Package dependencies as data, the closure RunPins pins is exactly the transitive closure of that declared relation resolved to exact versions, and an unsatisfiable range or a dependency the Blueprint does not install rejects the Blueprint before any package code loads.
- **C13-CLOUDFLARE-AUTHORITY-PERMIT-BINDING** A Cloudflare cross-DO authority permit binds every specified tenant, source, target, authority, intent, item, claim, pin, epoch, nonce, and time field.
- **C13-CLOUDFLARE-AUTHORITY-PERMIT-CONSUMPTION** The target validates local claim, fence, reservation identity/epoch, single use, and expiry, then irreversibly consumes a valid issued permit regardless of newer post-issuance watermark.
- **C13-CLOUDFLARE-RUN-HOSTING** A Run is Workspace-owned by default and may be pinned `dedicated` at start; its owner retains RunPins, active/terminal outcome, graph, and derived Settled obligations, and migration follows §5.2.
- **C13-CLOUDFLARE-ALARM-CLAIMS** The object's single alarm is arbitrated by durable per-owner claims and tracks the earliest live one, so no owner clobbers another's wakeup.
- **C13-CLOUDFLARE-RECONCILIATION-DRIVER** The reconciliation driver's claim tracks the earliest durable outbox entry, armed on enqueue, rebuilt at startup, and released when the outbox drains.
- **C13-CLOUDFLARE-ALARM-DURABILITY** An armed alarm survives instance loss and a throwing handler, and the platform, not an external re-arming path, recovers it.
- **C13-CLOUDFLARE-RECONCILIATION-RETRY** A failed reconciliation is rescheduled to a bounded retry time rather than acknowledged, and settles on a later sweep.
- **C13-CLOUDFLARE-RECONCILIATION-FENCE** Outbox acknowledgement and reschedule fence on the schedule the sweep observed, so a mid-sweep reschedule survives.
- **C13-CLOUDFLARE-VIEW-ATTACHMENT** The per-socket acknowledged-revision cursor survives hibernation and eviction in the attachment, and replay is exactly the unacknowledged suffix.
- **C13-CLOUDFLARE-QUEUE-DISPOSITION** Accepted deliveries are acknowledged, declined ones redelivered, and an undecodable body is neither delivered nor acknowledged but left to dead-lettering.
- **C13-CLOUDFLARE-STORAGE-LIMIT** The declared DO SQLite size bound is one the deployed platform accepts, and write seams refuse an over-limit payload before opening a transaction.
- **C13-CLOUDFLARE-DEPLOYMENT-CONTINUITY** Alarm claims, armed alarms, outbox entries, and the view revision log survive a Worker deployment in either direction, and the release serving the object resumes that work.
- **C13-CLOUDFLARE-ADDITIVE-MIGRATION** A release's migrations only add to the schema the previous release reads, a destructive change is staged across two releases, and a mechanical check refuses a non-additive migration.
- **C13-CLOUDFLARE-ROLLBACK-WINDOW** An object rolled back one release constructs and refuses every operation with the profile's unreadable-schema code, leaving its durable state recoverable by rolling forward.
- **C13-ADV-STALE-LEASE** A displaced durable lease is rejected after its epoch advances.
- **C13-ADV-WRONG-TURN-LEASE** Adversarial tests cover a wrong-Turn lease.
- **C13-ADV-REVOKED-ALLOW** A revoked backing allow Grant no longer authorizes an intent.
- **C13-ADV-NEW-DENY** A new matching deny denies an intent an allow previously admitted.
- **C13-ADV-DELAYED-WATERMARK** A relevant epoch advance with delayed delivery keeps direct calls inside the bounded window and denies mediated calls.
- **C13-ADV-MEDIATED-STALE** Adversarial tests cover mediated stale observation.
- **C13-ADV-IMMUTABLE-DEADLINE** Lease renewal cannot extend an existing resolution deadline.
- **C13-ADV-EMPTY-PLACEMENT** Adversarial tests cover every empty placement intersection.
- **C13-ADV-OMITTED-TRUST-SET** An accepted trust set cannot be empty.
- **C13-ADV-FORGED-INITIATOR** A provenance Principal cannot be forged.
- **C13-ADV-UNAUTHENTICATED-PROJECTION** An unauthenticated structural projection cannot bridge Actors.
- **C13-ADV-SUBSTITUTED-INITIATOR** A routed initiator remains exact.
- **C13-ADV-MISSING-CROSS-TENANT-BINDING** A cross-tenant relation without its authority Binding does not decode.
- **C13-ADV-DUPLICATE-ROUTE** Duplicate Events reuse one route dedupe identity.
- **C13-ADV-EMPTY-BATCH** An empty batch is rejected.
- **C13-ADV-NONHOMOGENEOUS-BATCH** Adversarial tests cover a non-homogeneous batch.
- **C13-ADV-COMPETING-CLAIMS** Exactly one item claim is current.
- **C13-ADV-NONFUTURE-CLAIM** Equal and past claim expiries are rejected.
- **C13-ADV-PREMATURE-RECOVERY** Recovery before the current claim expires is rejected.
- **C13-ADV-POST-ATTEMPT-RECOVERY** Recovery after an attempt was admitted is rejected.
- **C13-ADV-STALE-RECOVERY-OWNER** Adversarial tests cover a stale recovery owner.
- **C13-ADV-UNCHANGED-RECOVERY-OWNER** A claim recovers only under a different worker.
- **C13-ADV-RECOVERY-ORDINAL** Recovery that advances an unattempted ordinal is rejected.
- **C13-ADV-EARLY-AGGREGATE** Adversarial tests cover an early aggregate.
- **C13-ADV-SUPPLIED-ITEM-KEY** Adversarial tests cover a supplied item key.
- **C13-ADV-CHANGED-ITEM-KEY** A changed derived item key is rejected.
- **C13-ADV-REORDERED-INTENT** Adversarial tests cover a reordered intent.
- **C13-ADV-STRUCTURAL-INTENT-CHANGE** Changed prepared arguments under the original identity are rejected.
- **C13-ADV-APPROVAL-REPLAY** Adversarial tests cover approval replay.
- **C13-ADV-RECEIPT-DENIED** Denied pre-effect Receipts stay outside attempted lineage.
- **C13-ADV-RECEIPT-CANCELLED** Adversarial tests cover cancelled pre-effect Receipt lineage.
- **C13-ADV-RECEIPT-SUCCEEDED** A succeeded attempted Receipt without its exact initial attempt lineage is rejected.
- **C13-ADV-RECEIPT-FAILED** A final failed Receipt binds to its exact attempted effect.
- **C13-ADV-RECEIPT-INDETERMINATE** Adversarial tests cover indeterminate attempted Receipt lineage.
- **C13-ADV-RECEIPT-SUPERSESSION** One indeterminate Receipt is superseded exactly once, and batch outcomes derive from the result.
- **C13-ADV-RECEIPT-AGGREGATE** Every BatchOutcome precedence and terminal projection is covered.
- **C13-ADV-POST-FENCE-SYSTEM-EVIDENCE** Adversarial tests cover post-fence system evidence.
- **C13-ADV-TURN-MERGE** Completing one Turn with another Turn's valid commit is rejected.
- **C13-ADV-NONBINARY-MERGE** Adversarial tests cover a non-binary merge.
- **C13-ADV-UNEQUAL-PIN-MERGE** An unequal-pin merge is rejected, and exact new pins are adopted across restart.
- **C13-ADV-INCOMPLETE-PACKAGE-CLOSURE** A root commit with an incomplete authoritative Package closure is rejected.
- **C13-ADV-ADMITTED-SIBLING** Adversarial tests cover terminalization with an admitted sibling.
- **C13-ADV-POST-TERMINAL-ROUTE** Adversarial tests cover a post-terminal route.
- **C13-ADV-POST-TERMINAL-PREPARATION** Adversarial tests cover post-terminal preparation.
- **C13-ADV-POST-TERMINAL-CONTROL** Adversarial tests cover a post-terminal control write.
- **C13-ADV-COMMAND-REJECTIONS** Adversarial tests cover every command-envelope rejection.
- **C13-ADV-UNAUTHORIZED-WRITER** Adversarial tests cover an unauthorized commit writer.
- **C13-ADV-NONPREEXISTING-AUDIT** An audit edge whose cause has not been appended is rejected.
- **C13-ADV-UNBRIDGED-CROSS-ACTOR-AUDIT** A direct cross-Actor audit cause is rejected.
- **C13-ADV-CACHE-LOSS** A lost derived index rebuilds from canonical content.
- **C13-ADV-HOSTILE-TIER** Adversarial tests cover a hostile tier assertion.
- **C13-ADV-UNAUTHORIZED-SLOT** An unauthorized slot contribution is denied.
- **C13-ADV-POST-PREPARATION-INTERCEPTOR** Adversarial tests cover an interceptor post-preparation rewrite.

## 14. The formal model

The Lean package models an abstract subset only. `artifacts/traceability.yaml` is the
sole detailed claim ledger: its status and remaining-evidence fields bound every claim.
This section names coverage categories and trace IDs, never inferred theorem names.

| Coverage category | Trace IDs | Boundary |
| --- | --- | --- |
| Structural Invocation identity and View replay | `AC-STRUCTURAL-001` | ideal whole-intent identity and structural replay only; no cryptographic or RFC 6902 claim |
| Operation-cut-point interception | `AC-INTERCEPTOR-001` | pipeline invariants over an admitted schedule the host supplies: total deterministic `(priority, facetId, interceptorId)` order with a unique schedule, last-rewriter attribution, scoped final blocks naming the exact blocker, behavior-free trace replay that refuses broken chains, `ReplayItem` assembly from completed runs, interception authority, and the §7.2 raise — no state admits a call with an applicable interceptor directly; candidate discovery, durable persistence, replay lookup, and the non-operation cut points are not modeled |
| Grants, Bindings, path epochs, and Role materialization | `AC-AUTH-001`, `AC-AUTH-RESOLUTION-001`, `AC-MATERIALIZE-001` | designated abstract authorization, path-evidence, deadline, holder-join, guest-attenuation, and rematerialization consequences only |
| Placement, trust, and exact-Turn leases | `AC-PLACEMENT-001`, `AC-TRUST-001`, `AC-LEASE-001` | pure four-set selection, the §7.2 tier floor including the Turn-owned session direct-execute exception (the own-filesystem `mutate` exception is not modeled; formal `mutate` is conservatively mediated), one source-tier rejection property, listed LeaseStep consequences over supplied inputs, and an executable step function proven sound and complete for the lease relation (the differential-testing oracle); no complete lifecycle claim |
| Environment and Session | `AC-ENVIRONMENT-001`, `NC-ENVIRONMENT-LIFECYCLE` | abstract Session transitions only: Turn-owned fail-closed use, terminal close with child disposal, rotation pinning, explicit egress binding, reachable credential isolation over the proxy seam, and fail-closed preview exposure; concrete provider, container, transport, and snapshot-format behavior is not modeled |
| Slate | `AC-SLATE-001`, `NC-SLATE-RUNTIME` | abstract record and isolate transitions only: version and publication immutability, rollback as an owned-pointer retarget without provider contact, preview as a live Environment Session, dynamic-only placement, and Binding-backed capability provenance for dynamic isolates; generated application code and concrete provider effects are not modeled |
| Approval, batch effects, and Receipt lineage | `AC-APPROVAL-001`, `AC-EFFECT-001` | designated invocation-level ticket guards, first-attempt consumption, persisted continuation validation, guarded attempts, owner-changing same-ordinal no-attempt claim recovery, disjoint Receipt IDs, failed effect-attempt retry, supersession, and derived aggregates; approval UI, concrete atomicity, normative expiry detection, scheduling, provider effects, and reconciliation liveness are not proved |
| Event routing and typed audit | `AC-EVENT-ROUTING-001`, `AC-ROUTING-001`, `AC-AUDIT-001` | lease-backed self-Event checks, authenticated target projection without a source-audit edge, designated Actor-local audit consequences, and the Subscription routing LTS — at-most-once consumption per (Subscription, event key), declared-target firing, tenant containment, channel-derived trust admission, and fail-closed disable; no reservation uniqueness, transport, storage, or complete-instrumentation claim |
| Run settlement and graph-writer consequences | `AC-RUN-001`, `AC-GRAPH-WRITER-001` | exact source-pin identities, complete admitted unfinished frontier capture including an honest empty frontier, system-fenced forced cancellation, the formal terminal-and-unheld sibling precondition, a constructive Settled witness on a graph reached from the empty graph by `GraphStep`, unary pin inheritance, equal-pinned current merge heads, matching delivery evidence, exact-Turn controlled synthesis, and undo as fenced append-only ancestor selection — no transition writes an undo onto a branch a running Turn still holds, whatever the lease expiry, and no transition removes or rewrites a stored commit; no source-record resolvability, complete runtime lifecycle, closed writer matrix, expected-head CAS, pending-revert durability, migration execution, resource-ceiling attenuation or exhaustion, or general settlement-preservation claim |
| Integrated admission and settlement | `AC-COMPOSED-001` | designated direct admission, non-attempt mediated preparation, and an abstract distributed mediated-permit LTS. The target first durably records an immutable request and retains it after consumption; the Tenant issues from only its authority state and the authenticated request payload; typed messages cross a lossy/duplicating/reordering transport; and the target authenticates and consumes against the exact request, volatile authentication, fence, time, claim, reservation, lease, route, and audit state without reading issuer storage. Attempt-producing generic mediated transitions are excluded, so a reachability invariant gives every modeled EffectAttempt an exact retained request, historical Tenant issuance, target consumption, and matching-attempt evidence. No Actor-local boolean or claimed authority admission path is modeled; a future Actor-local attempt path requires ownership that permits the canonical comparison and attempt write in one transaction. Designated consequences cover reset-authentication invalidation, expiry, changed fences, and before/after commit-unknown issuance and consumption. Live authority administration is deliberately absent until a capability-mediated administration path is modeled; raw `AuthorityStep` is not admitted as a runtime transition. The abstract permit embeds the exact modeled request directly and binds its modeled PreparedInvocation, claim, reservation, binding generation, fence, actor, nonce, and time fields; it neither represents every concrete §10.3 wire field nor proves collision resistance for concrete `requestDigest`. Settlement retains its constructive exact-obligation witness; no concrete transaction or refinement claim |
| Platform mechanism representations | `AC-REP-BROKER-001`, `AC-REP-CONSENT-001`, `AC-REP-REACTION-001`, `AC-REP-MOA-001` | proved component reductions to core modules: broker credential custody with the digest-bound approval gate, per-pair consent epochs, reaction dedup and lease-fenced injection, and aggregation-chain lineage completeness; no profile, product, UX, or implementation-refinement claim |
| Facet manifest/runtime | `NC-FACET-MANIFEST-RUNTIME` | §4.1 correspondence, operation implementation, loading, and declared-impact truth are not modeled |
| Contributions and slots | `AC-SLOT-001`, `NC-CONTRIBUTIONS-SLOTS` | immutable slot declarations, exclusive contribution origins, schema-conformant stored entries, and declared-order arrival-independent resolution; slot authority policy, concrete JSON-Schema validation, the viewer-filtered SlotCatalog query, and surface-backed rendering are not modeled |
| Commands | `AC-COMMAND-001`, `NC-COMMANDS` | per-surface per-Scope collision rejection, exact derived-Subscription defaults, install-checked mappings with validated `command.invoked` input, and duplicate-submission idempotency; concrete schema-compatibility checking, argument grammar, completion providers, alias and visibility configuration, dispatcher gate ordering, and `command.completed` rendering are not modeled |
| Interceptors | `NC-INTERCEPTORS` | §4.4 runtime candidate discovery, durable trace persistence, transactional replay lookup, new-pass InvocationId allocation, the declared-mode band and gate fidelity, and the `prompt.assemble`, `input.submitted`, and `turn.step` cut points are not modeled; the operation cut points are claimed under `AC-INTERCEPTOR-001`, whose ordering claim is the within-mode `(priority, facetId, interceptorId)` key over the schedule the host supplies |
| Surface, profile, and patch semantics | `NC-SURFACE-RUNTIME-ACTIONS`, `NC-PROFILE-RUNTIME`, `NC-RFC6902-PATCH` | explicit non-claims beyond the structural View result |
| Substrate and definition-plane behavior | `AC-COMPOSED-001`, `NC-CONTENTSTORE`, `NC-CODECS`, `NC-PROTOCOL-DISPATCHER`, `NC-BLUEPRINT-MATERIALIZATION`, `NC-CLOUDFLARE-BEHAVIOR` | the abstract distributed permit safety relation is modeled; concrete command-envelope rejection ordering, complete §10.3 permit representation, signatures/codecs, Durable Object transactions, storage/RPC failure semantics, network topology, bundles, configuration, and deployments are not |
| Liveness, cryptography, and concrete refinement | `NC-TEMPORAL-LIVENESS`, `NC-CRYPTOGRAPHIC-COLLISION-RESISTANCE`, `NC-TYPESCRIPT-SUBSTRATE-REFINEMENT` | explicit non-claims; assumptions are listed separately in the ledger |

No structural View result implies RFC 6902 correctness, the no-live-handle runtime
boundary, Surface semantics, or profile behavior. No representation helper implies a
profile implementation is safe or conforming. The ledger claims only the designated
abstract consequences in each row and its narrower per-ID boundary. It does not close
the full Run writer matrix, expected-head CAS, complete lifecycle, item-claim scheduler,
command dispatcher, or any concrete persistence, authentication, timing, network,
provider, resource-bound, or UI implementation.

Operational use relies on these external assumptions, not hidden formal conclusions:

- authentication and provenance map requests to the correct Principal, Actor, and
  Tenant;
- cross-tenant verification authenticates the claimed home Tenant and explicit bridge
  Binding;
- trusted monotonic time enforces lease expiry and immutable resolution deadlines;
- codecs are canonical and chosen digests meet their stated collision assumptions;
- each owning Actor's persistence linearizes its own guarded transaction and preserves
  append-only records; there is no cross-Actor atomicity assumption. Commit-unknown is
  observed as either the before-state or the fully committed local after-state, never a
  partial write;
- loaded Facet code matches its manifest, schemas, declared impact, and placement;
- provider idempotency keys identify the intended effect;
- invalidation transport, cross-Actor delivery, reconciliation, and provider queries
  are eventually scheduled only under an explicit fairness/eventual-delivery premise
  when an eventual-liveness result is required. No designated liveness theorem is
  claimed; safety rules fail closed and do not assume eventual progress.

Proving that TypeScript, an adapter, or a deployment refines Lean is explicitly not a
goal of this formal package. Implementation conformance comes only from §13 evidence
and tests under the declared operational assumptions.

## 15. Open questions

One decision remains:

1. **The public name.** "Agent Core" collides with a shipping AWS product (Bedrock
   AgentCore). Undecided.

**Run/Turn vocabulary — decided; the current names stand.** Three levels exist here:
a Run holds the lineage, a Turn is one execution attempt, and a Turn step is one
iteration of the Turn's loop. The last two already match how agent harnesses name
them. Only the container differs: this document says Run where others say session or
thread.

Session cannot take that role, because §4.5 gives the name to Environment sessions.
Thread is free, and it is the closest industry word, but it describes a straight line.
A Run branches, merges, and keeps named heads over immutable commits. Thread would
make the most distinctive property of the structure harder to see, and this document
also uses "single-threaded" for Durable Objects in §10. The rename trades one lookup
for a permanent inaccuracy, so the names stay and Appendix A carries the translation.

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
| mediated Invocation | durable intent/receipt pipeline; approval when policy requires |
| Interceptor | plugin hook; middleware; tool wrapper |
| ingress | webhook endpoint; channel adapter |

## Appendix B — Artifacts

Future machine-readable record and protocol schemas MUST be generated from the
versioned codecs required by §8.3 rather than maintained as a competing source of
truth. The Lean model lives under `formal/`; its claim ledger is
`artifacts/traceability.yaml`. The condensed introduction is the repository's
[README](../../README.md).
