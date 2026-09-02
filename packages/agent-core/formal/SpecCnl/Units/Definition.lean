import SpecCnl.Unit

/-!
# Definition: reviewed pairings for §9.1 and §9.3

The rule units here are about the definition plane: what a Package declares as data, what
a Blueprint validates against before anything runs, and what re-applying a Blueprint to a
Scope is guaranteed to converge on.

The model has no Blueprint record. `AgentCore.BlueprintId` is an opaque `Nat` wrapper and
`AgentCore.BlueprintPin` is an id, a version, and a digest; there is no Package record, no
declared-dependency relation, no `settings` fragment, no schema composition, and no step
that loads code. What the model does have on this plane is two records: the
`AgentCore.MaterializerLedger`, whose `installed` table maps a `(BlueprintId,
SubscriptionTemplateName)` pair to the one `SubscriptionId` the template materialized
into, and `AgentCore.RunPins.packageClosure`, the exact-version package closure every
commit carries. Both sentences below are therefore claims about *those two records* and
say nothing about a Blueprint document, a dependency graph, or a load order.

Two systematic omissions. Nothing here claims an ordering between two events, because the
model is a labelled transition system with no temporal operator and, for this plane, no
second event to order against. And nothing here claims a rejection *path*: the model
states its gates as preconditions of the step that lands, so "rejects the Blueprint"
appears only as "no such step exists".
-/

namespace SpecCnl.Corpus.Units.Definition

def units : List RuleUnit :=
  [ { key := "C13_BLUEPRINT_CONVERGENCE"
      atoms := ["C13-BLUEPRINT-CONVERGENCE"]
      specSection := "9.3"
      anchor := "SPEC.md:3601"
      digest := "4905530937ce255519d86d4eb1aa936b63f15d6aae2990ffcbfe79d6a227d69f"
      sentence :=
        "every template reconciliation maintains stored materializer records and every \
         materializer step maintains installed template stability and additionally every \
         materializer ledger installs at most one subscription per blueprint template"
      dropped :=
        [ "'the Blueprint-managed record set a Scope holds once it is converged is a \
           function of the Blueprint alone, independent of the order in which the \
           materializer issued the admissible installs, updates, and withdrawals and of \
           the managed record set the Scope held before'. THE SENTENCE IS WEAKER THAN THE \
           ATOM. The model has no converged record set and no function from a Blueprint to \
           one, and AgentCore.MaterializeLabel has exactly two constructors — materialize \
           and reconcile — so there is no update label and no withdrawal label for an \
           order to be quantified over. What the sentence carries is the three per-step \
           facts that make the endpoint determined: re-application changes nothing, no \
           step ever moves an installed template's id, and one blueprint template names at \
           most one Subscription",
          "'Records no Blueprint declares — Runs, Turns, Events, Receipts, and everything \
           else §8.4 assigns an owning Actor — lie outside the managed set and outside \
           this property': the model has no Blueprint-managed marking on any record. \
           AgentCore.MaterializerLedger.installed is the only Blueprint-indexed table, so \
           the managed/unmanaged distinction the exclusion rests on is unrepresentable",
          "'a manual edit is adopted only as a change to the Blueprint, and an edit no \
           Blueprint change expresses is rejected rather than adopted as an unattributed \
           managed record': there is no manual-edit transition to admit or refuse",
          "the whole pending-obligation apparatus — 'A materializer's reconciliation \
           outcome MUST carry its pending set, and a Scope is converged exactly when that \
           set is empty and converging otherwise', the durable pending obligation naming \
           record, reason, and discharging condition, and the four deferrals the document \
           states (a withdrawal held by §4.1's reliance guard, each draining admitted \
           Invocation item, each unadmitted RouteReservation, and a Package §5.2 still \
           pins). The model has no reconciliation-outcome record, no pending set, and no \
           deferral, so none of it has a referent",
          "'A divergence a host cannot express as a pending obligation with a discharging \
           condition is a rejected reconciliation, refused at validation before any \
           package code loads (§9.2)': the model has neither a validation relation over a \
           Blueprint nor a code-load step, which is the same absence that leaves \
           C13-BLUEPRINT-VALIDATE-BEFORE-LOAD unbridged",
          "'Convergence fixes the endpoint and does not promise arrival, and this document \
           claims no quiescence', with the finiteness and no-waiting-on-later-obligations \
           argument that follows it: a claim about what the specification does and does \
           not promise rather than a property of a transition",
          "'re-applying reconciles (create, update, remove-managed) rather than \
           duplicates' is claimed by C13-BLUEPRINT-REMATERIALIZE, whose sentence carries \
           the never-duplicates half. This sentence carries the complementary half — that \
           the stored no-op really is a no-op, in the installed table and in the routing \
           ledger both — and the model still has no update path and no remove-managed path",
          "AgentCore.MaterializerLedger.installed is a function field, so the third \
           clause's at-most-one property is structural in the model. It cannot distinguish \
           an implementation relation that tries to store two ids for one blueprint \
           template, and the bridge does not claim that it can",
          "the third clause's subject noun 'materializer ledger' denotes fun _ => True and \
           so cannot refuse a wrong subject; the entry carries Caveat.typeAsCommonNoun and \
           the quantification is over every inhabitant of the type, which is why \
           bridge_C13_BLUEPRINT_CONVERGENCE is a real proof that strips the True rather \
           than Iff.rfl" ] },
    { key := "C13_PACKAGE_DEPENDENCY_DECLARED"
      atoms := ["C13-PACKAGE-DEPENDENCY-DECLARED"]
      specSection := "9.1"
      anchor := "SPEC.md:3478"
      digest := "1a46204387d35fdfa881a8db6d85b0271109c1fea3f272208cbd9f24b3868338"
      sentence :=
        "every graph step requires a nonempty package closure for the migrated commit and \
         every graph step requires unique package pins for the migrated commit"
      dropped :=
        [ "'A Package declares its dependencies as data: a set of entries unique by id, \
           each naming a PackageId and the Package range (§5.2) that satisfies it, read \
           alongside its manifests without executing anything'. THE SENTENCE IS WEAKER \
           THAN THE ATOM, AND CARRIES NO DECLARED DEPENDENCY AT ALL. The model has no \
           Package record, no dependency entry, and no version range: AgentCore.PackageId \
           is an opaque Nat wrapper and AgentCore.PackagePin is exactly { package, \
           version, manifestDigest, codeDigest }. What the sentence carries is the \
           pinned-closure half — the shape AgentCore.RunPins.Valid requires of the closure \
           a pin change declares",
          "'The closure RunPins.packages pins (§5.2) is exactly the transitive closure of \
           that declared relation from the Blueprint's packages list, resolved to exact \
           versions; a pinned closure that is not the closure of a declared relation is \
           invalid rather than merely unexplained': with no declared relation and no \
           Blueprint record in the model, neither the equality nor the invalidity claim \
           has anything to range over. This is the atom's main clause and the bridge is no \
           evidence for it",
          "'unique by PackagePin.id': AgentCore.PackagePin has no id field. \
           AgentCore.RunPins.Valid requires the closure to be Nodup under \
           PackagePin.package, so the second clause carries uniqueness by PackageId and \
           not by a pin identity the model does not have",
          "'resolved to exact versions' and 'The closure is finite': \
           AgentCore.PackagePin.version is a required field and the closure is a List, so \
           a rendering of either clause would be true by construction and therefore \
           vacuous",
          "'An unsatisfiable range, or a dependency on a Package the Blueprint does not \
           install, rejects the Blueprint before any package code loads (§9.2)': no range, \
           no Blueprint record, and no load step, so there is no refusal to quantify over",
          "'A dependency relates Package releases and is never a FacetManifest.bindings \
           entry: a dependency names code a release needs present, a BindingRequirement \
           names a live capability a Facet needs bound (§4.1), the two are resolved by \
           different planes, and a host MUST NOT derive either from the other': the model \
           has neither a FacetManifest nor a BindingRequirement record — \
           AgentCore.Binding is a live domain-and-scope name, not a requirement — so the \
           two planes the clause keeps apart are not both present to be confused",
          "'what decides whether a composition is admissible is data a host reads, never \
           behavior it runs': a statement about the discipline the manifest/runtime split \
           applies, not a property of a transition",
          "both clauses quantify over the whole graph relation and name \
           AgentCore.GraphLabel.migrate only in the lifter, so a step whose label is not a \
           migration satisfies them trivially and the content sits at the migrate \
           constructor — the one label that carries the RunPins the model validates. \
           AgentCore.GraphStep also requires RunPins.Valid at startRun and at terminalize, \
           but the Run record it reads there is existential in the constructor and is not \
           recoverable from the label, so a condition on a source state and a label cannot \
           reach it",
          "the clauses bound the closure the migration commit *declares* — the pins in its \
           RunCommitKind.migration payload, which AgentCore.CommitAllowed separately \
           equates with the commit's own pins — rather than the closure of every commit in \
           the store, and they say nothing about the agent-identity half of \
           AgentCore.RunPins.Valid" ] } ]

end SpecCnl.Corpus.Units.Definition
