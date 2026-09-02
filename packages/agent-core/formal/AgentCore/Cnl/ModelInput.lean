import AgentCore.Content

/-!
# Consequences of the existing content model the controlled language needs

`AgentCore.Content` proves that resolving a ref whose bytes the ledger no longer stores is
refused — `missing_content_resolution_rejected` — but it states that fact in refusal form:
a missing ref admits *no* resolve step. §5.6's retention-loss rule is read off the same
seam from the other side: whatever a resolve step does produce, the content it named was
still retained when it ran, so nothing shorter, partial, or best-effort is reachable
through this transition. The controlled language needs that positive form, because a
`requires` sentence is a precondition on the transitions that exist rather than a
statement about the ones that do not.

Nothing here changes a definition. `content_resolution_requires_retained_content` reads
`ContentStep`, `ContentLabel.resolve`, and `ContentLedger.stored` exactly as
`AgentCore.Content` declares them, and its proof is the case analysis over the two
existing resolve constructors — the same analysis
`content_resolution_requires_home_or_grant` performs for the tenant half of the same
premise.
-/

namespace AgentCore

/-- **A resolve step's content was still retained when it ran.** Both resolve
constructors — home Tenant and explicitly granted — carry `stored ref = true` as a
premise, so an admitted resolution of a `ContentRef` is evidence that the ledger still
held the content, and no resolution of collected content is available to approximate it.

This is `missing_content_resolution_rejected` stated positively: that theorem says a
missing ref admits no resolve step, and this one says every resolve step names a ref that
is not missing (§8.2, and §5.6's `C13-TURN-MODEL-INPUT-RETENTION-LOSS`). -/
theorem content_resolution_requires_retained_content {ledger after ref requester}
    (step : ContentStep ledger (.resolve ref requester) after) :
    ledger.stored ref = true := by
  cases step with
  | resolveHome stored => exact stored
  | resolveGranted stored _ => exact stored

end AgentCore
