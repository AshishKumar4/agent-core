import SpecCnl.Unit

/-!
# ViewPlan: reviewed pairings for §6.3 and §6.4

§6.3 says what a View is — a projection a Surface streams as revision-based patches, with
provenance on what a human is asked to decide and a terminal patch when the Surface is
retired. §6.4 says what the plan projection is — tasks and dependencies folded out of the
Event log, acyclic, append-only, and summarised by a critical path. The model has the
patch-streaming half of §6.3 exactly, and has nothing else this domain asks for.

`AgentCore.View` is the whole View model and it is small: `ViewNode` is a list of rendered
blocks, `ViewPatch` is `replace` or `append`, `ViewState` is a revision and a body,
`ViewDelta` is a base revision and a patch, `applyDelta` is the guarded fold step, and
`replay` is the fold. One record below is bridged from it, and it carries the streaming
mechanics rather than the atom's leading refusal: what a View may *not* hold is a claim
about absent fields, and the model's fields are already exactly two.

**Eight of this group's nine units are not bridged, and two absences account for all
eight.** They are recorded here rather than as records, because a record whose four
declarations cannot exist is not a weaker pairing but a missing one.

* **No View carries provenance, and no Surface exists.** `C13-VIEW-APPROVAL-PROVENANCE`
  discriminates a decision View by the presence of an `intentDigest` field and requires
  every non-host body value to be marked with the TrustTier of the input it came from in
  the View's `marks` list; `C13-VIEW-WITHDRAWAL-TERMINAL` needs a `SurfaceId`, a
  `SurfaceEpoch` counted by first render, a withdrawal that retires a Surface, and a
  `terminal` field the final ViewDelta adds. `AgentCore.ViewState` has `revision` and
  `body` and `AgentCore.ViewNode` has `blocks`, so none of those fields exists; there is
  no Surface record anywhere in the model — `AgentCore.CommandRegistry.surfaces` keys a
  command registration by `(Scope, SlotName, CommandName)` and never names a View — no
  epoch ladder over registrations, and no withdrawal or retirement relation of any kind.
  `AgentCore.ApprovalLedger` holds decision state for an `InvocationId` and nothing
  relates it to a `ViewState`, so the provenance a decision View is supposed to carry has
  nothing to range over either.
* **The plan projection is not in the model at all.** The six `C13-PLAN-*` units are about
  a record `AgentCore` does not have: there is no plan, no task, no `TaskId`, no declared
  dependency, no declarer, and no critical path. The run graph's commit DAG is a different
  record with different closure rules — its edges are commit parents pinned by
  `AgentCore.RunCommit.pins` and closed by `AgentCore.ParentsClosed`, not dependencies
  declared and retracted by decoded Event payloads — so bridging a plan rule to it would
  claim agreement between two structures the specification keeps apart. §5.2's own atoms
  own the commit graph and `SpecCnl.Corpus.Units.RunGraph` carries them.
-/

namespace SpecCnl.Corpus.Units.ViewPlan

def units : List RuleUnit :=
  [ { key := "C13_VIEW_NO_LIVE_STATE"
      atoms := ["C13-VIEW-NO-LIVE-STATE"]
      specSection := "6.3"
      anchor := "SPEC.md:2622"
      digest := "ba0939309ba37f637eaaf519d80125f9c7ea2d6f37799c3a6f03b88aa32b94be"
      sentence :=
        "every view apply requires a matching revision and every view apply establishes \
         the patched successor and additionally every view replay establishes the counted \
         revision"
      dropped :=
        [ "'A View MUST carry no live Facets, stubs, credentials, or hidden state — refs \
           only'. THE SENTENCE IS WEAKER THAN THE ATOM. AgentCore.ViewNode has one field, \
           blocks : List String, and AgentCore.ViewState is exactly a revision and a body, \
           so there is no field a live Facet, a stub, or a credential could occupy and the \
           refusal is a signature-level negative that is not statable inside the theory. \
           Rendering it as 'view replay depends only on the body and the revision' was \
           considered and rejected: that projection is the whole two-field record, so the \
           proposition would hold of any function of any state and would be vacuous rather \
           than weaker. What the sentence carries instead is the derivation the atom's \
           second clause names — a delta applies only against the revision it names, the \
           successor is exactly that revision plus one over the patched body, and a \
           replayed View sits exactly as many revisions on as its stream is long",
          "'RFC 6902 JSON Patches' and 'compatible with AG-UI's STATE_DELTA convention': \
           AgentCore.ViewPatch is two constructors over an explicit ViewNode, replace and \
           append, so the model has no JSON Patch operation set and no wire convention for \
           a sentence to name",
          "'so clients update without re-snapshotting': the model has no client and no \
           snapshot request. The third clause carries the model's form of the claim, \
           AgentCore.replay_revision — folding a stream of n deltas from a base View lands \
           exactly n revisions on, so the stream alone determines the revision a client \
           holds",
          "'Surface actions emit Events; Subscriptions route them to Operations': the \
           model has AgentCore.EventStep and AgentCore.RoutingStep, but no Surface and no \
           relation between a View and either ledger, so the routing half has nothing to \
           range over. C13-SUBSCRIPTION-ACCEPTED-TIERS carries the routing filter over the \
           Subscription ledger itself",
          "'Aggregating surfaces — dashboards — compose slot-contributed child Views per \
           §4.2': AgentCore.SlotEntry carries a StructuralValue rather than a View and no \
           definition assembles a ViewState from AgentCore.SlotLedger.resolve, so \
           composition has nothing to range over",
          "'Token-level model-output streaming is an executor and transport concern \
           (§5.6), not Events': a statement about which plane owns a concern rather than a \
           property of a transition",
          "the sentence quantifies over applications that succeed: every view apply is the \
           family of AgentCore.applyDelta before delta = some after, so the stale-delta \
           refusal is carried contrapositively — a delta whose base is not the View's \
           current revision belongs to no admitted transition — rather than as a claim \
           about the none branch of a function's value, which is not a transition and has \
           no category here" ] } ]

end SpecCnl.Corpus.Units.ViewPlan
