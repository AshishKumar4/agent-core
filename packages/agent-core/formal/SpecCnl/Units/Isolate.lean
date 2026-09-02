import SpecCnl.Unit

/-!
# Isolate: reviewed pairings for §4.7, §4.6, and §9.2

The rule units filed here are about agent-authored code: what authority a dynamic isolate
holds, where that authority comes from, what a name inside it can reach, and what a
published Slate exports. The model behind them is `AgentCore.Slates`, whose
`DynamicDomain` is a capability table plus an action log and whose `SlateLedger` is the
record plane a running platform moves.

What the sentences here systematically do not carry is **declaration**. The §4.7 units
are largely about records a Blueprint, a manifest, or a publication declares — a
consumer-to-backing map, an Operation's `availability`, a `BindingRequirement` set, a
Slate skeleton — and the model carries none of those: it carries the *transition*
consequences those declarations exist to guarantee. Every sentence below is therefore a
statement about admissible isolate or Slate steps, and each record says in its `dropped`
list which declaration it dropped and why the model has no referent for it. Three units of
this group are not in the corpus at all for the same reason, and are reported rather than
rendered: `C13-FACET-CODE-AVAILABILITY`, `C13-SLATE-SKELETON-CREDENTIAL-FREE`, and
`C13-SLATE-INSTANTIATE-SCOPE`.
-/

namespace SpecCnl.Corpus.Units.Isolate

def units : List RuleUnit :=
  [ { key := "C13_AUTH_ISOLATE_DELEGATION"
      atoms := ["C13-AUTH-ISOLATE-DELEGATION"]
      specSection := "4.7"
      anchor := "SPEC.md:1285"
      digest := "8dac9ac6dcb6ea1367990d38ef3754dbdb9e674942ce6572a35cfe5659b6a6e7"
      sentence := "every isolate step establishes only host passed capabilities"
      dropped :=
        [ "'the §3.4 rules bound the passed set exactly as they bound any other delegate: \
           equal at most, never wider, deny not delegable'. THE SENTENCE IS WEAKER THAN \
           THE ATOM. AgentCore.IsolateCapability carries a destination and nothing else \
           — no facet pattern, no operation list, no impact set — and \
           AgentCore.IsolateStep.pass has no premise relating the passed capability to \
           any capability the loading code holds, so the containment \
           AgentCore.Capability.Covers states for a §3.4 delegation has no isolate-side \
           instance to bound. What the sentence carries is the delegation-not-transport \
           half: the only way any capability ever enters the isolate's table is an \
           explicit host pass, and no step the isolate itself takes widens it",
          "'so revoking a passed Grant severs the isolate without touching its loader': \
           AgentCore.IsolateLabel has no revoke constructor and \
           AgentCore.DynamicDomain.passed stores capabilities rather than GrantIds, so \
           neither the revocation nor the Grant edge it would travel is representable",
          "'The isolate's Invocations present its own delegated authority — never the \
           authority of the code that loaded it': the model has no loader domain beside \
           the isolate's, so the contrast has no second term. The sentence carries only \
           that the isolate's own table is the sole source",
          "'§1.5 already says nothing else crosses a domain boundary', a cross-reference \
           whose transition content C13-PLACEMENT-DYNAMIC-NO-EGRESS already claims" ] },
    { key := "C13_AUTH_ISOLATE_NAMESPACE_CLOSED"
      atoms := ["C13-AUTH-ISOLATE-NAMESPACE-CLOSED"]
      specSection := "4.7"
      anchor := "SPEC.md:1305"
      digest := "0fb81fe406ac6d3eaf7dc3d579e957aa7bf4407659a2f57e36e1ef9a0bdadc42"
      sentence := "every isolate invocation requires a passed binding for the invocation"
      dropped :=
        [ "'one entry each under its BindingName, fixed when the isolate is built and \
           acquiring no entry afterwards': AgentCore.DynamicDomain.passed is keyed by \
           BindingId and not by a BindingName, so the by-name indexing is unmodelled, and \
           AgentCore.IsolateStep.pass admits a new entry at any point in a run, so \
           'acquiring no entry afterwards' is stronger than the model. The sentence \
           carries resolution closure, which is the atom's MUST",
          "the sentence carries closure as the positive precondition every admitted \
           invocation satisfies rather than as the refusal the atom words it as, 'MUST \
           resolve to nothing at all'. The two are contrapositives in the model: with \
           AgentCore.DynamicDomain.passed at none for a name, no invoke step on it exists",
          "'not to a value the hosting language's environment supplies, not to a \
           built-in, and not to a property inherited by whatever structure a host \
           assembled the namespace from': the three ambient sources are facts about a \
           host language, with no model construct each. The model excludes them jointly \
           by admitting no invocation at all without a passed entry, rather than one at \
           a time",
          "'a Binding may take a name the hosting language also uses', 'this document \
           fixes no reserved-name list', and 'a host MUST NOT satisfy this rule by \
           renaming a passed Binding', which are all about names the model does not carry",
          "'An inadmissible name is refused under C13-AUTH-BINDING-NAME-CANONICAL before \
           the isolate exists' and the C13-FACET-START-ATOMIC clause on a half-built \
           namespace, which are other atoms' rules",
          "'every call it carries is the ordinary Invocation §7.2 tiers': an isolate step \
           records the invoke and no tier, so the enforcement floor is outside this \
           domain" ] },
    { key := "C13_PLACEMENT_AUTHORED_BACKING"
      atoms := ["C13-PLACEMENT-AUTHORED-BACKING"]
      specSection := "4.7"
      anchor := "SPEC.md:1321"
      digest := "f3db62e56707c7066862608a6ac939633be209b21a65324221378cf931e7dab5"
      sentence := "every isolate step preserves binding backed actions"
      dropped :=
        [ "'A platform declares which backing serves each of the three consumers this \
           section names ... as part of policies.placement (§9.2): one more mapping, \
           consumer → backing id'. THE SENTENCE IS WEAKER THAN THE ATOM. \
           AgentCore.PlacementSet is three booleans over bundled, provider, and dynamic, \
           and AgentCore.choosePlacement reads nothing else, so the model has no backing \
           id, no consumer, and no consumer-to-backing mapping. The atom's main clause \
           has no referent here",
          "'identified by a substrate-defined, opaque, nonempty id; this document fixes \
           no enum of them', and 'A consumer the Blueprint does not map uses the \
           profile's declared default backing', for the same reason",
          "'Every offered backing MUST preserve identical authority semantics'. The \
           sentence carries those semantics once, for the single dynamic domain \
           AgentCore.IsolateStep defines, and drops the quantification over backings that \
           is the requirement. A green bridge here is not evidence that two backings agree",
          "'each backing demonstrates this independently, the same way any dynamic-mode \
           implementation does, never by comparison against another backing', a \
           proof-obligation discipline rather than a transition rule",
          "the base case of the invariant. AgentCore.fresh_actions_backed proves the \
           fresh isolate satisfies it, and the grammar has no sentence form for a claim \
           about one designated state, so the sentence carries the preservation step \
           alone and AgentCore.reachable_isolate_actions_are_binding_backed is what \
           closes the induction" ] },
    { key := "C13_SLATE_SKELETON_ARTIFACT"
      atoms := ["C13-SLATE-SKELETON-ARTIFACT"]
      specSection := "9.2"
      anchor := "SPEC.md:3552"
      digest := "5601d045e293cf2fcf1fb699f23fa4ccfc3a5f1c560c8562c7924c71fd9dc106"
      sentence :=
        "every slate step establishes a committed head advance and every slate step \
         maintains committed version immutability"
      dropped :=
        [ "'A Blueprint declares no Slates, and materialization (§9.3) places none', and \
           'A Slate skeleton (§4.6) is therefore its own artifact rather than a field of \
           this record'. THE SENTENCE IS WEAKER THAN THE ATOM. \
           AgentCore.MaterializerLedger holds a Blueprint-to-template index and a routing \
           ledger and has no Slate field at all, so a rendering of 'materialization \
           places no Slate' would be true by construction and therefore vacuous, and \
           there is no skeleton record for the artifact claim to be about. The sentence \
           carries the two premises the atom argues from: a Slate's head is advanced by a \
           platform Operation and by nothing else, and a version history is never retired",
          "'Skeleton export and Blueprint materialization are separate planes, and a host \
           MUST NOT derive either from the other': a non-derivation obligation between \
           two artifacts, one of which the model does not have",
          "'which C13-BLUEPRINT-CONVERGENCE forbids, because the managed record set of a \
           converged Scope is a function of the Blueprint alone', which is another atom's \
           rule and would need the managed-record set the model does not carry",
          "'reconciliation's remove-managed step would retire a version history no \
           Blueprint change expresses'. The second clause carries that no Slate \
           transition retires a committed version, which is the fact the atom reasons \
           from, not the claim about what reconciliation would do",
          "'it is not the JSON outline above ... a Slate skeleton is a durable \
           declaration with a codec of its own', a codec and artifact-shape claim with no \
           model construct" ] } ]

end SpecCnl.Corpus.Units.Isolate
