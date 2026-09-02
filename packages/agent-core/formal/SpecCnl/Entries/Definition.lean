import SpecCnl.Parse
import SpecCnl.Grammar

/-!
# Definition vocabulary

Two records, so two paradigms — and only one of them needs a new transition family.

* **The materializer.** `AgentCore.MaterializerLedger` already contributes
  `every template materialization`, `for the materialization`, and `an unmaterialized
  template` to the core lexicon. This section adds the reconcile family, the whole
  relation as `every materializer step`, and the two two-state relations convergence needs
  — that reconciliation leaves both fields of the ledger alone, and that no step of any
  kind moves an installed template's `SubscriptionId`. The ledger itself also appears as a
  subject, because the at-most-one property is a property of one ledger rather than of a
  transition; `materializer ledger` denotes `fun _ => True`, carries
  `Caveat.typeAsCommonNoun`, and the `True` it introduces is stripped in the bridge rather
  than hidden here.
* **The pinned package closure.** No new `GraphStore` family: the landed `every graph
  step` is the whole relation, and `AgentCore.GraphLabel.migrate` — the one label that
  carries the `RunPins` the model validates — is named in the lifter instead. The lifter
  has exactly the shape the core `for the appended commit` has, at the same two categories
  and a different surface. The two conditions read the pins out of the commit's
  `RunCommitKind.migration` payload, where `AgentCore.RunPins.Valid` is checked, in the
  same way the core `a selected ancestor` reads the selection out of a
  `RunCommitKind.undo` payload.

`AgentCore.GraphLabel.migrate` is also the label family of `CnlRunPins`'s §5.2 unit, which
adds its own family entry and its own lifter under different surfaces. The two lifters are
a reviewed redundancy rather than a collision: both conditions here are
`ST[AgentCore.GraphStore,AgentCore.RunCommit]` and compose with either lifter unchanged,
so keeping one lifter across the merged lexicon is a deletion here plus the surface in the
sentence.

Every denotation is a term over `AgentCore` alone. `stored materializer records` is stated
field by field rather than as `after = before` so that it names the model constants it is
about; the two are equivalent and the field-wise form is what the hand proposition and the
discharge use.
-/

namespace SpecCnl.Entries.Definition

def entries : List LexEntry :=
  [ { id := "blueprint.every.template.reconciliation"
      surface := "every template reconciliation"
      category := "TR[AgentCore.MaterializerLedger,AgentCore.MaterializeLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ blueprint template, " ++
        "label = AgentCore.MaterializeLabel.reconcile blueprint template) ∧ " ++
        "AgentCore.MaterializeStep before label after" },
    { id := "blueprint.stored.materializer.records"
      surface := "stored materializer records"
      category := "PR[AgentCore.MaterializerLedger]"
      denotation :=
        "fun before after => " ++
        "AgentCore.MaterializerLedger.installed after = " ++
        "AgentCore.MaterializerLedger.installed before ∧ " ++
        "AgentCore.MaterializerLedger.routing after = " ++
        "AgentCore.MaterializerLedger.routing before" },
    { id := "blueprint.every.materializer.step"
      surface := "every materializer step"
      category := "TR[AgentCore.MaterializerLedger,AgentCore.MaterializeLabel]"
      denotation := "AgentCore.MaterializeStep" },
    { id := "blueprint.installed.template.stability"
      surface := "installed template stability"
      category := "PR[AgentCore.MaterializerLedger]"
      denotation :=
        "fun before after => ∀ blueprint name id, " ++
        "AgentCore.MaterializerLedger.installed before blueprint name = some id → " ++
        "AgentCore.MaterializerLedger.installed after blueprint name = some id" },
    { id := "blueprint.materializer.ledger"
      surface := "materializer ledger"
      category := "CN[AgentCore.MaterializerLedger]"
      denotation := "fun _ => True"
      caveats := [.typeAsCommonNoun] },
    { id := "blueprint.installs.at.most.one.subscription.per.blueprint.template"
      surface := "installs at most one subscription per blueprint template"
      category := "NP[AgentCore.MaterializerLedger]\\S"
      denotation :=
        "fun ledger => ∀ blueprint name left right, " ++
        "AgentCore.MaterializerLedger.installed ledger blueprint name = some left → " ++
        "AgentCore.MaterializerLedger.installed ledger blueprint name = some right → " ++
        "left = right" },
    { id := "blueprint.for.the.migrated.commit"
      surface := "for the migrated commit"
      category :=
        "ST[AgentCore.GraphStore,AgentCore.RunCommit]" ++
        "\\ST[AgentCore.GraphStore,AgentCore.GraphLabel]"
      denotation :=
        "fun cond before label => ∀ run id expected commit, " ++
        "label = AgentCore.GraphLabel.migrate run id expected commit → cond before commit" },
    { id := "blueprint.a.nonempty.package.closure"
      surface := "a nonempty package closure"
      category := "ST[AgentCore.GraphStore,AgentCore.RunCommit]"
      denotation :=
        "fun _ commit => ∀ pins operation receipt, " ++
        "AgentCore.RunCommit.kind commit = " ++
        "AgentCore.RunCommitKind.migration pins operation receipt → " ++
        "AgentCore.RunPins.packageClosure pins ≠ []" },
    { id := "blueprint.unique.package.pins"
      surface := "unique package pins"
      category := "ST[AgentCore.GraphStore,AgentCore.RunCommit]"
      denotation :=
        "fun _ commit => ∀ pins operation receipt, " ++
        "AgentCore.RunCommit.kind commit = " ++
        "AgentCore.RunCommitKind.migration pins operation receipt → " ++
        "(List.map AgentCore.PackagePin.package " ++
        "(AgentCore.RunPins.packageClosure pins)).Nodup" } ]

end SpecCnl.Entries.Definition
