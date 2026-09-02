import SpecCnl.Unit

/-!
# Receipts: reviewed pairings for §7.4

The rule units here govern Receipt lineage — which Receipt variant an item may hold, when
an indeterminate head may be superseded, and that records are never rewritten — the
aggregate outcomes derived from a batch of items, and the causal exclusions the Audit log
enforces around Receipts and the cross-Actor route bridge.

Three weaknesses are systematic across this group and are repeated in each record's
`dropped` list rather than assumed.

* **Lineage is carried one step at a time.** The model has no reachability predicate for
  `AgentCore.EffectLedger`, so "never updated or deleted" is rendered as preservation
  across an arbitrary step, which composes along a trace but is not itself a trace claim.
* **A failure kind does not exist in the model.** `AgentCore.AttemptOutcome` is
  `succeeded | failed | indeterminate` and `AgentCore.AttemptReceipt` carries no kind
  field, so every clause that classifies *how* an attempted effect failed is dropped, and
  `C13-RECEIPT-FAILURE-KIND` is reported unbridged rather than paired with a sentence.
* **A cross-plane premise is invisible to a sentence about one plane.**
  `AgentCore.AuditStep` takes the `EffectLedger` and the `EventStore` as indices, so a
  transition family over the Audit log quantifies them existentially and no condition can
  read the reservation, the projection, or the effect evidence that step checked. What can
  be said about those planes is said through `AgentCore.MayCause`, which is a relation on
  entry kinds alone.
-/

namespace SpecCnl.Corpus.Units.Receipts

def units : List RuleUnit :=
  [ { key := "C13_RECEIPT_IMMUTABLE"
      atoms := ["C13-RECEIPT-IMMUTABLE"]
      specSection := "7.4"
      anchor := "SPEC.md:3111"
      digest := "283bfbcea5510586275fb5174f58a69808b7e4635e812a96937eec2f876179ad"
      sentence :=
        "every effect step maintains recorded receipt immutability and \
         every receipt chain supersession requires an indeterminate chain head \
         for the prior receipt"
      dropped :=
        [ "'A PreEffectReceipt is terminal for its item and has no EffectAttempt or \
           supersession': the no-supersession half holds because supersession looks its \
           target up in attemptReceipts and AgentCore.ReceiptIdsDisjoint keeps the two \
           tables apart, which is what C13-RECEIPT-ID-NAMESPACE already claims, so this \
           sentence does not restate it. The no-EffectAttempt half is carried by \
           C13-RECEIPT-FAILURE-ORTHOGONAL's sentence instead",
          "'An AttemptReceipt references one existing EffectAttempt': also carried by \
           C13-RECEIPT-FAILURE-ORTHOGONAL's second clause rather than here",
          "'Its first record has no previous': AgentCore.EffectStep's firstAttemptReceipt \
           constructor requires it, and the second clause of this sentence is a condition \
           on the source state of a supersession, so a field of the appended record is \
           outside what it can read",
          "'by succeeded or failed for the same attempt': the model enforces both — the \
           superseding outcome is AttemptOutcome.Final, which admits exactly succeeded and \
           failed, and the two records name one attempt. Both are properties of the record \
           the step appends, and the sentence's condition reads only the state the step \
           starts from, so only the indeterminate-head and at-most-once halves are carried",
          "'Attempts and Receipts are never updated or deleted' as a claim over a whole \
           run: the first clause carries per-step preservation of both receipt tables, \
           because the model has no reachability predicate for EffectLedger for a trace \
           claim to range over. The attempt half of the same clause is \
           C13-EFFECT-ATTEMPT-IMMUTABLE's",
          "'An item's current Receipt is its PreEffectReceipt, or the chain head for its \
           greatest attempt ordinal': a definition of the currentReceipt projection, \
           maintained by every step function rather than stated by one of them",
          "'A new ordinal is allowed only after the prior ordinal is finally failed; \
           neither succeeded nor indeterminate admits a concurrent retry': \
           AgentCore.retry_requires_prior_final_failure is the model's form, and no clause \
           of this sentence carries it" ] },
    { key := "C13_RECEIPT_FAILURE_ORTHOGONAL"
      atoms := ["C13-RECEIPT-FAILURE-ORTHOGONAL"]
      specSection := "7.4"
      anchor := "SPEC.md:3145"
      digest := "cacc101c3e9257634e9f5909a724dede02bb781de7ba5719c569e9b75bc68a37"
      sentence :=
        "every pre effect receipt establishes an item without a recorded attempt \
         for the recorded receipt and every first attempt receipt establishes \
         an existing attempt for the recorded attempt receipt"
      dropped :=
        [ "'The failure kind is orthogonal to the pre-effect distinction, never a \
           replacement for it'. THE SENTENCE IS WEAKER THAN THE ATOM. The model has no \
           failure kind at all: AgentCore.AttemptOutcome is succeeded, failed, and \
           indeterminate, and AgentCore.AttemptReceipt carries no kind field, so the \
           orthogonality claim has no second axis to be orthogonal to. What the sentence \
           carries is the axis that does exist — the Receipt variant an item holds answers \
           whether an effect was attempted",
          "'and by nothing else': an exhaustiveness claim about what may answer the \
           attempted question, and the grammar has no form for exhaustiveness over the \
           ways a model might answer it",
          "'the item never crossed the boundary': the sentence carries the observable form \
           of this, that the item the recorded pre-effect Receipt names has no latest \
           attempt, not a claim about a boundary the model does not represent",
          "'it MUST NOT be recorded where this document requires another outcome — a \
           denial before the effect stays deniedPreEffect, an expiry, cancellation, or \
           loss of a required Turn before the effect stays cancelledPreEffect': every one \
           of these clauses polices where a failure kind may be written, and the model has \
           no failure kind to police",
          "'an attempt whose result is not known stays indeterminate until reconciliation \
           supersedes it': the supersession rule is carried by C13-RECEIPT-IMMUTABLE's \
           sentence, not by this one",
          "'naming a kind is a determination': a statement about what recording a kind \
           means, which needs the absent kind to have a referent" ] },
    { key := "C13_BATCH_OUTCOME_COMPLETE"
      atoms := ["C13-BATCH-OUTCOME-COMPLETE", "C13-BATCH-OUTCOME-TERMINAL"]
      specSection := "7.4"
      anchor := "SPEC.md:3184"
      digest := "401e7dd6decc1a004ee754b5d0b52618cd45dc5c2562937af7d7fc9027576fbc"
      sentence :=
        "the derived batch outcome assigns at most one value and \
         the terminal batch outcome assigns at most one value"
      dropped :=
        [ "'BatchOutcome MUST be unavailable until every item has a current Receipt'. THE \
           SENTENCE IS WEAKER THAN THE ATOM. The model does enforce it: \
           AgentCore.ItemCurrentOutcome is False wherever currentReceipt is none, so no \
           outcome list of the prepared Invocation's length exists and no aggregate is \
           derivable. The grammar's only sentence shapes over a state-relative relation are \
           functionality and projection-dependence, and neither states conditional \
           unavailability, so what the sentence carries is the determinism half — one \
           ledger and one Invocation admit one aggregate",
          "'A TerminalBatchOutcome MUST be available exactly when the derived BatchOutcome \
           is non-indeterminate'. THE SENTENCE IS WEAKER THAN THE ATOM. The biconditional \
           is definitional in the model, since AgentCore.BatchTerminalOutcome is \
           BatchCurrentOutcome with a non-indeterminate aggregate, and the grammar has no \
           biconditional sentence shape. The second clause carries only that the terminal \
           aggregate is as unique as the derived one",
          "'those Receipts need not be final, so the derived outcome may be indeterminate': \
           an existence claim, witnessed by \
           AgentCore.indeterminate_batch_is_current_not_terminal and by \
           AgentCore.mixed_terminal_batch_is_partial. A uniqueness sentence says nothing \
           about which aggregates occur",
          "the derivation cascade itself — any indeterminate to indeterminate, all \
           succeeded to succeeded, some succeeded to partiallySucceeded, otherwise any \
           failed to failed, otherwise any cancelledPreEffect to cancelled, otherwise \
           denied: the sentence carries that the cascade is a function, not which case it \
           takes",
          "'Neither aggregate is a Receipt or substitutes for item evidence': a negative \
           claim about substitution, naming no model construct that could fail it",
          "'Aggregate denied and cancelled therefore cannot be confused with the item \
           outcomes deniedPreEffect and cancelledPreEffect': AgentCore.BatchOutcome and \
           AgentCore.ItemOutcome are distinct types, so the confusion is unrepresentable \
           rather than excluded, and a rendering would be vacuous" ] },
    { key := "C13_AUDIT_ROUTE_BRIDGE"
      atoms := ["C13-AUDIT-ROUTE-BRIDGE"]
      specSection := "7.4"
      anchor := "SPEC.md:3259"
      digest := "498411ce8d4fc87b95d2f424823a8e0c62db1d7e02f3f0555017a94b5a8cb39e"
      sentence :=
        "every route projection bridge establishes a fresh cause free bridge root \
         for the bridge entry"
      dropped :=
        [ "'Cross-Actor causality MUST NOT point directly into another Audit log': the \
           same-Actor half of that refusal is AgentCore.LocalCauseValid's requirement that \
           a cause share its child's Actor, which C13-AUDIT-EDGE-RELATION already claims. \
           This sentence carries the other half, that the bridge entry stands with no \
           AuditRecord cause at all",
          "'The source-owned RouteReservation is the authenticated bridge', and 'it is \
           admitted only by authenticating that reservation projection': \
           AgentCore.AuditStep takes the EventStore as an index, so a transition family \
           over the Audit log quantifies it existentially and no condition can read the \
           reservation, its authentication, its digest, or the projectionFor index the \
           projectionBridge constructor checks. \
           AgentCore.projection_uses_reservation_bridge_not_source_audit is where those \
           premises are visible",
          "'Delivery is caused by the target-local projection entry': the model states it \
           as AgentCore.MayCause admitting only a routeProjected parent into a delivery \
           entry, and as AgentCore.delivery_audit_cites_target_local_projection over a \
           causal chain. AgentCore.AuditLabel has no delivery constructor, so no transition \
           family scopes a sentence to a delivery append",
          "'a target-local bridge root' as a claim about the Actor that owns it: the entry's \
           Actor equals the reservation's target owner, which again lives on the EventStore \
           side of the step and cannot be read here",
          "AgentCore.MayCause admits no edge into a routeProjected kind at all, so the \
           bridge root can never acquire a cause later. That is a kind-level claim about \
           the relation rather than about this step family, and the sentence does not carry \
           it" ] },
    { key := "C13_AUDIT_TELEMETRY_EXCLUDED"
      atoms := ["C13-AUDIT-TELEMETRY-EXCLUDED"]
      specSection := "7.4"
      anchor := "SPEC.md:3274"
      digest := "a69959b635628d392f618b8f3d01837884762833bd066670eea94fb05a283ad8"
      sentence :=
        "every non attempt audit kind causes no attempted outcome kind and \
         every non indeterminate audit kind causes no receipt supersession kind"
      dropped :=
        [ "'Telemetry is diagnostic and never substitutes for a Receipt, RouteReservation, \
           WriteRecord, or AuditRecord'. THE SENTENCE IS WEAKER THAN THE ATOM. The model \
           has no telemetry construct of any kind, so the atom's own exclusion has nothing \
           to exclude and no sentence can carry it. Three of the four records it names do \
           exist — AgentCore.PreEffectReceipt and AgentCore.AttemptReceipt, \
           AgentCore.RouteReservation, AgentCore.WriteRecord and AgentCore.AuditEntry — and \
           the sentence instead carries which audit kinds may cause a Receipt record",
          "'Every Receipt outcome has an AuditRecord'. THE SENTENCE IS WEAKER THAN THE \
           ATOM. This is a completeness claim across two planes, and the model relates them \
           only through AuditStep's existentially bound EffectLedger index: \
           AgentCore.AuditEvidenceMatches checks an entry that exists against the ledger, \
           and never asserts that an entry exists for an outcome. No state predicate pairs \
           an EffectLedger with an AuditLog, so there is nothing for such a sentence to \
           quantify over",
          "the exact identities each permitted edge requires — that an attempt record's \
           cause names the same attempt and Invocation, and that a receiptSuperseded record \
           links the same previous Receipt, attempt, and Invocation. The object determiner \
           carries which kinds are refused, not the equalities the admitted kind must \
           satisfy. C13-AUDIT-EDGE-RELATION drops the edge enumeration entirely, so these \
           two clauses are the first of AgentCore.MayCause's rows any bridge tests",
          "'pre-effect outcomes are caused by Invocation or terminal Approval audit': a \
           third clause would need a common noun for the complement of two kinds at once, \
           and the sentence already uses both of its clauses",
          "'before the final Receipt is observed': an ordering between the supersession \
           entry and the final Receipt, and the audit plane has no temporal operator; \
           sequence numbers order entries within one Actor, not entries against Receipts",
          "'Every SystemCause MUST name the exact preexisting receipt, delivery, or control \
           AuditRecord required by the writer matrix': AgentCore.SystemCause is a RunGraph \
           commit writer, and the exactness the model enforces is checked by \
           AgentCore.ReceiptCommitAudit, AgentCore.DeliveryCommitAudit, and \
           AgentCore.ControlCommitAudit, each of which reads the AuditLog that \
           AgentCore.GraphStep takes as an index. A commit-writer sentence could carry that \
           the writer names its kind's own Receipt, but not that the AuditRecord preexists, \
           which is the clause's point" ] } ]

end SpecCnl.Corpus.Units.Receipts
