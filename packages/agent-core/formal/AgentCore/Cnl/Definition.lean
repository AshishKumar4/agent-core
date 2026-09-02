import AgentCore.Materializer

/-! # Consequences of the existing materializer model the controlled language needs -/

namespace AgentCore

/-- **A materialized template name names one Subscription.**
`materialized_automation_has_unique_firing_subscription` states this of a
`SubscriptionTemplate`, reading the name off the template record. The controlled language
quantifies over the `installed` table's own key type, because a sentence about the ledger
has no template record to read a name from, and the two conditions of a
`(BlueprintId, SubscriptionTemplateName)` lookup are what convergence is about. Reads
`MaterializerLedger.installed` and nothing else; no definition changes. -/
theorem installed_name_has_unique_subscription {ledger : MaterializerLedger}
    {blueprint : BlueprintId} {name : SubscriptionTemplateName} {left right : SubscriptionId}
    (leftInstalled : ledger.installed blueprint name = some left)
    (rightInstalled : ledger.installed blueprint name = some right) : left = right := by
  rw [leftInstalled] at rightInstalled
  exact Option.some.inj rightInstalled

end AgentCore
