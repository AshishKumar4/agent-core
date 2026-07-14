# Agent Core

*AI tools have been used to shape parts of this document and the project. The ideas and concepts presented here are of my own, and they may change as I ideate further.*

## A specification and reference implementation for building agentic platforms

Over the last couple of years I have built several agentic platforms — a general background
agents platform and a self-evolving platform [Proteus](https://github.com/AshishKumar4/proteus) on Cloudflare Durable Objects, a vibe-coding platform that generates and
deploys apps, and a few smaller ones. Every single time, I found myself rebuilding the
same set of pieces from scratch: agents that survive restarts, multi-tenancy, sandbox orchestrations, agentic harness, agentic orchestration,
vaults so the agent can act on someone's behalf without ever seeing their secrets,
sandboxes with preview URLs, approval flows for the risky actions, a way for webhooks
and schedules and chat messages to all feed the same agent loop, and some way to share
all of it with a team. These pieces take time to polish and get right, and they always
end up coupled to the product they were built for, so nothing carries over to the next
platform.

The existing frameworks don't really help at this layer. Agent SDKs give you the loop
and stop there. The hosted platforms give you a control plane, but it's theirs, shaped
like their product. What I kept wishing for was a box of well-designed Lego blocks for
the platform layer itself.

Agent Core is my attempt at building that box. It defines a small set of primitives —
sixteen of them — that compose into complete agent platforms, and a definition plane
above them so that an entire platform can be described by a configuration document
(a *Blueprint*) and deployed onto a backend. The primary backend is Cloudflare Durable
Objects, but the model itself is backend-agnostic.

The full specification lives in
[`packages/agent-core/SPEC.md`](packages/agent-core/SPEC.md). This README is the short
version.

![The system at a glance](packages/agent-core/diagrams/overview.svg)

## The core ideas

**Authority works like a capability.** The idea is that nothing in the system acts
because of *who it is* — things act because of *what they hold*. Durable allow and deny
*Grants* share one enforcement plane; a *Binding* names an allowed Facet inside one
isolation domain, and resolution evaluates every matching Grant on the exact Scope
path. Roles materialize ordered allow/deny rules into those Grants rather than creating
a second access path. Direct use requires path-epoch evidence, an unstaled delivered
watermark, an exact Turn lease, and an immutable deadline. This is the object-capability model (the ideas go
back to
Mark Miller's work), and the reason I care about it is prompt injection: an agent reads
untrusted content all day, and if it also holds broad ambient authority, injected
instructions will eventually find something to do with it. Capabilities keep the blast
radius of any single compromise small and revocable.

**Everything durable is a record with a single owner, and every input is an event.** A
conversation is stored as an append-only commit graph with named branches and exact
root/Turn/system writers, so branching
a conversation, undoing a step, and running parallel attempts are just graph
operations. An execution attempt is a *Turn* that holds an exact-Turn lease with a
fencing epoch,
which means a crashed executor that comes back later simply cannot write anything — all
of its writes carry a stale epoch and get rejected. And a webhook, a cron tick, a slash
command, and a button press are all the same thing: an *Event*, routed by a
*Subscription*. Automation becomes configuration instead of plumbing.

**Enforcement is tiered by impact.** Every protected action is an *Invocation*, but an
agent loop makes thousands of small read calls per session, and writing five durable
records for every file read would make the whole thing unusable. So enforcement
depends on the operation's declared impact: reading a file in the agent's own sandbox
is a plain in-memory call with a bounded resolution deadline, while sending an email
freezes one shared PreparedInvocation header plus ordered payload and records optional approval,
optional effect attempts, immutable receipts, and Actor-local audit lineage. You can always tighten policy; the
defaults
are just honest about what each kind of call costs.

## The primitives

| Layer | Primitives |
| --- | --- |
| Identity & authority | Principal · Scope (Tenant ⊇ Project ⊇ Workspace) · Grant · Binding |
| Composition | Facet · Operation · Interceptor · Environment · Slate |
| Execution | Agent · Run · Turn |
| Interaction | Event · Subscription · Surface |
| Mediation | Invocation |
| Definition plane | Package · Blueprint |

A *Facet* bundles operations, UI surfaces, events, and prompt text into one
installable capability, split into a declarative manifest and a runtime class. The
manifest's *contributions* compile down to the existing primitives — a slash command,
for example, is just a manifest entry that becomes a catalog entry plus a derived
Subscription, and the authority, approval, and audit machinery applies to it
automatically. A *Slate* is an application the agent builds for you; its backend runs
in a fresh isolate with no ambient authority at all.

And this is what the whole thing is for — a platform ends up being a document:

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
      "defaultAllowed": ["provider", "dynamic"]
    },
    "tiers": { "acme.deploy:deploy.run": "mediated" }
  }
}
```

It is validated before any package code loads, materialized idempotently, and
re-applying it converges instead of duplicating. The same document that configures the
platform is the one a reviewer can diff and a second backend can deploy.

## The formal model

The Lean 4 package (`packages/agent-core/formal/`) checks an abstract subset only.
[`packages/agent-core/artifacts/traceability.yaml`](packages/agent-core/artifacts/traceability.yaml)
is the detailed claim ledger; SPEC §14 lists its coverage
categories and explicit nonclaims. It does not prove that the TypeScript, storage
adapters, or a deployment refine the model. Those are conformance-test obligations.

## Status

The normative target is the specification, not the current implementation. Conformance
requires the evidence in SPEC §13. Versioned record codecs remain required and are the
source for any future generated machine schema.
The open questions — starting with the project's public name — are listed in
[SPEC §15](packages/agent-core/SPEC.md#15-open-questions). If you spot mistakes or
have suggestions, please open an issue.

## Layout

```text
packages/agent-core/
  SPEC.md          the specification — start here
  diagrams/        the spec's diagrams (hand-built SVG)
  src/             reference implementation (TypeScript)
  test/            behavior + conformance tests
  formal/          abstract Lean 4 model
  artifacts/       formal claim traceability
```

## License

MIT
