import SpecCnl.Unit

/-!
# Commands: reviewed pairings for §4.3

A Command is a contribution: installing one registers a name in every declared surface
slot of a Scope, derives one Subscription from fixed defaults, and validates an argument
value against the declared schema before any Event is emitted. The four pairings below
are about the installation and invocation transitions of `AgentCore.CommandRegistry` —
name collision, the derived route's fixed defaults, the exactness of that derivation, and
the mapping and schema checks that bracket argument binding.

What every sentence here systematically does not carry:

* **No Event identity.** `AgentCore.CommandInvocation` records a Scope, a `CommandId`, and
  the validated Operation input. No `EventId`, `SurfaceId`, `RunRef`, or branch appears
  anywhere in the command model, and `AgentCore.Event` has no correlation field, so every
  correlation clause of §4.3 is dropped rather than approximated.
* **No alias table and no visibility policy.** The collision exception ("unless the Scope
  configures an alias") and the per-Scope visibility `MAY` name records the model does not
  have.
* **No payload projection.** `AgentCore.CommandRoute` carries source, accepted trust,
  target, dedupe, and authority. The root-of-`/input` projection is described in the
  module prose as common to every derivation and is not a field, so the
  `mapping`-defaults-to-root-to-root clause has nothing to range over.

Two of this group's six rule units are **not** bridged, and no sentence here pretends to
carry them. `C13-COMMAND-COMPLETION-IMPACT` needs a command's `completion` Operation and
that Operation's `observe` impact: `AgentCore.CommandDecl` has no completion field,
nothing in the model relates a command to `AgentCore.InvocationImpact`, and there is no
`SlotCatalog` or catalog query at all. `C13-COMMAND-RESULT` needs an emitted
`command.completed` Event correlated to the invoking Event's id: `AgentCore.CommandLabel`
has exactly three constructors — install, reinstall, invoke — none of which emits a
completion, and the command module's own prose places `command.completed` result
rendering outside the model.
-/

namespace SpecCnl.Corpus.Units.Commands

def units : List RuleUnit :=
  [ { key := "C13_COMMAND_COLLISION"
      atoms := ["C13-COMMAND-COLLISION"]
      specSection := "4.3"
      anchor := "SPEC.md:952"
      digest := "b34a068a0929380899f6979995370b183075a6ca50378823f18612f62cd5abba"
      sentence :=
        "every command install requires an unregistered surface name for the installed \
         command and every command step maintains recorded surface registrations"
      dropped :=
        [ "'unless the Scope configures an alias': AgentCore has no alias table, so the \
           exception is unrepresentable and the sentence carries the unconditional \
           freshness requirement instead",
          "'Per-Scope visibility policy (§9.2) MAY disable individual commands', which is \
           a MAY and names no model construct",
          "'The materializer registers the command in each declared surface slot' as a \
           positive post-state claim: the sentence carries the precondition that every \
           declared position is free and the stability that keeps a rejected collision \
           rejected. AgentCore.installation_registers_exact_derived_route is where the \
           registration half lives, and C13_COMMAND_INVOCATION_CORRELATION is the unit \
           whose sentence reads the stored record",
          "the arrival-order phrasing 'a collision rejects the later contribution': the \
           model has no arrival order, and the two clauses together give the \
           order-independent form — the position must be free to install, and no \
           transition ever frees it" ] },
    { key := "C13_COMMAND_SUBSCRIPTION_DEFAULTS"
      atoms := ["C13-COMMAND-SUBSCRIPTION-DEFAULTS"]
      specSection := "4.3"
      anchor := "SPEC.md:944"
      digest := "92d949e7c41a6b1095c093ef8f4d7e35df59910db3e8fb661001f590a5bf80cc"
      sentence :=
        "every command install requires a nonempty declared trust set for the installed \
         command and every command install maintains the derived route defaults"
      dropped :=
        [ "'defaults mapping to root-to-root identity': AgentCore.CommandRoute has no \
           payload-projection field. The root-of-`/input` projection is common to every \
           derivation by construction rather than stored, so a rendering of this default \
           would be a claim about a record the model does not carry",
          "'Delegated automation MUST be explicit': AgentCore.CommandAuthority.delegated \
           exists but no transition ever produces it — deriveCommandRoute always yields \
           initiator authority — so the explicitness requirement has no install path to \
           constrain and a rendering would be vacuous",
          "'An automation template ... using its binding' as a statement about templates: \
           the model's rendering of the template defaults is deriveCommandRoute, so the \
           sentence is about the installation that stores that derivation",
          "'Its source.acceptedTrust is always explicit': the model's declared trust is \
           an Option and the derivation supplies defaultCommandTrust when it is absent, \
           so the sentence carries nonemptiness of the derived set and the refusal of an \
           explicitly empty one, not the explicitness of the declaration" ] },
    { key := "C13_COMMAND_INVOCATION_CORRELATION"
      atoms := ["C13-COMMAND-INVOCATION-CORRELATION"]
      specSection := "4.3"
      anchor := "SPEC.md:974"
      digest := "3d0c7c45e8ce923f396723cff1cfdccd3a6d9ba71f13b30823c60db8bbb363cd"
      sentence :=
        "every command install maintains an exactly derived stored route and every \
         command declaration derives an exact subscription"
      dropped :=
        [ "'whose correlation MUST carry the originating SurfaceId and, when invoked from \
           a conversation, the RunRef/branch'. THE SENTENCE IS WEAKER THAN THE ATOM. \
           AgentCore.CommandInvocation carries a Scope, a CommandId, and the validated \
           input, and AgentCore.Event has no correlation field at all, so no correlation \
           obligation is statable. The sentence carries only the derived-routing half: \
           the stored route is exactly the derivation, and the derived Subscription is \
           exactly the supplied tenant and target with exactly the derived accepted-trust \
           set. A green bridge here is not evidence for the atom's correlation clause",
          "'The surface emits Event(command.invoked)': the invocation step appends a \
           CommandInvocation record, and no EventId is minted anywhere in the command \
           model",
          "the derived Subscription's target is a supplied InvocationId rather than one \
           synthesized from the command's Operation, as AgentCore.deriveSubscription's \
           own scoping note records; the sentence claims exactness against what was \
           supplied, and the route's target-equals-declared-Operation clause is carried \
           by C13_COMMAND_SUBSCRIPTION_DEFAULTS",
          "'no inferred compatibility relation' as a negative about absent machinery: a \
           relation the signature does not contain is not statable inside the theory, so \
           the sentence states the positive exactness that an inferred relation would \
           have to break" ] },
    { key := "C13_COMMAND_ARGUMENT_BINDING"
      atoms := ["C13-COMMAND-ARGUMENT-BINDING", "C13-COMMAND-INSTALL-MAPPING"]
      specSection := "4.3"
      anchor := "SPEC.md:967"
      digest := "304c4922f2df8a590234d0f8baae6fccaaaddf3a1aae9d654a7b981dcdd8b6ed"
      sentence :=
        "every command install establishes an install checked mapping and every command \
         invocation establishes a validated operation input"
      dropped :=
        [ "'A Surface owns its input grammar and produces a FacetData value': the model \
           has no surface grammar and no FacetData, so the argument value arrives as a \
           StructuralValue on the invoke label and the sentence carries what the schema \
           does to it",
          "'CLI token ordering, quoting, and flags belong to the CLI Surface profile', \
           which the rule unit itself excludes from the core contract",
          "'With no mapping, the validated value is passed through unchanged': \
           AgentCore.CommandDecl.mapping is a total MappingId rather than an Option, so \
           the model has no no-mapping case to distinguish and the pass-through half is \
           unrepresentable",
          "'before any Event is emitted' as an ordering claim: the model has no temporal \
           operator, so schema validity is carried as a guard on the transition that \
           appends the invocation record",
          "'both schemas MUST be checked at install' as a check on the declared schema \
           pair in isolation: the model's install guard is MappingSchemaSafe, which \
           relates the two schemas through the mapping, and that is what the sentence \
           carries" ] } ]

end SpecCnl.Corpus.Units.Commands
