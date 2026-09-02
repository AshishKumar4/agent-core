import SpecCnl.Unit

/-!
# Claims: reviewed pairings for §7.4

The four rule units here govern the scheduling state that sits between a prepared item and
an effect: which worker holds an item, at which attempt ordinal, until when, what may take
an abandoned hold over, and what evidence a Receipt is written on.

Two systematic weaknesses run through the whole group and are recorded on every record
that depends on them.

* **The model has no effect boundary and no external call.** `AgentCore.EffectLedger` is a
  ledger of records; nothing in it crosses a wire. So every "MUST precede the effect"
  clause is carried as a recorded-evidence precondition — the Receipt cannot exist without
  the attempt record — and never as an ordering against a call. Idempotency keys and
  reconciliation re-queries have no call and no external state to range over at all.
* **Concurrency is not represented.** "Atomic compare-and-set", "two executors", and
  "abandoned by a worker" are carried as the guard the transition enforces and the
  post-state it leaves, not as claims about indivisibility or about what another worker is
  doing.
-/

namespace SpecCnl.Corpus.Units.Claims

def units : List RuleUnit :=
  [ { key := "C13_CLAIM_INITIAL_ATOMIC"
      atoms := ["C13-CLAIM-INITIAL-ATOMIC", "C13-CLAIM-FUTURE-EXPIRY"]
      specSection := "7.4"
      anchor := "SPEC.md:3159"
      digest := "6cfb8687c4a904f23aa50c77c864a6c8eaf125a31610c67842d444aea66b1798"
      sentence :=
        "every claim step requires an unclaimed item for the claim and every claim step \
         establishes a future claim expiry for the claimed item and additionally every \
         claim step establishes an exact prepared owner for the claimed item"
      dropped :=
        [ "'Each nonterminal item has at most one live claim' as a property of a state: \
           AgentCore.EffectLedger.currentClaim is a function of the Invocation and the \
           item index, so at-most-one holds by construction and a rendering of it would \
           be vacuous. The first clause carries the transition guard that keeps it that \
           way — a claim step is admitted only where the item currently holds none",
          "'atomic compare-and-set' as a claim about the write being indivisible. The \
           model has no concurrent execution and no transaction, so what the sentence \
           carries is the guard on the source state and the post-state the step leaves, \
           not that the two happen without an interleaving",
          "'the first claim uses attempt ordinal 0': the ordinal a claim may take is \
           carried by C13_ATTEMPT_ORDINAL_AFTER_FAILURE's first clause instead, where \
           AgentCore.claim_ordinal_is_initial_or_follows_failure states both the \
           zero-ordinal case and the advance case. This sentence carries the expiry half \
           of C13-CLAIM-FUTURE-EXPIRY only",
          "'nonterminal': the guard the first clause carries is the absence of a live \
           claim, not the absence of a terminal Receipt. AgentCore.ClaimOrdinalAvailable \
           does require an un-receipted item at ordinal 0, and that half is carried by \
           C13_ATTEMPT_ORDINAL_AFTER_FAILURE",
          "'Claim ownership and expiry are scheduling state, separate from attempt \
           ordinal': AgentCore.ItemClaim carries an owner, an expiry, and an ordinal as \
           three independent fields, so the separation is true by construction and a \
           rendering would be vacuous",
          "'Only the current claim owner may append the one matching EffectAttempt for \
           that ordinal', and the field-by-field equality of invocation, item index, \
           ordinal, and token it spells out. \
           AgentCore.first_attempt_uses_exact_current_claim and \
           AgentCore.retry_uses_exact_current_claim_and_advances_ordinal prove it of the \
           model through AgentCore.ClaimOwnsAttempt, but a fourth sentence clause does \
           not exist: coordination is two clauses with 'and' and exactly three with 'and \
           additionally'",
          "'An executor claim embeds the exact LeaseToken; a system claim names its \
           owning Actor' is carried as AgentCore.ClaimOwnerMatchesPrepared, which is the \
           conjunction of exactly those two cases against the prepared header; the third \
           clause does not expose which case a given claim is in" ] },
    { key := "C13_CLAIM_RECOVERY_NO_ATTEMPT"
      atoms :=
        ["C13-CLAIM-RECOVERY-NO-ATTEMPT", "C13-CLAIM-RECOVERY-NEW-OWNER",
          "C13-CLAIM-RECOVERY-FUTURE-EXPIRY", "C13-CLAIM-RECOVERY-SAME-ORDINAL"]
      specSection := "7.4"
      anchor := "SPEC.md:3167"
      digest := "0afe3c11d68399eba6a46006b370b117d83dc29269d892f67cffdf5333f1d21c"
      sentence := "every claim recovery establishes a recovered claim for the claim recovery"
      dropped :=
        [ "'An abandoned claim MAY be recovered': the sentence carries the conditions \
           every recovery step the model admits satisfies, not the permission to attempt \
           one. A MAY has no transition to quantify over",
          "'An ordinal that already has an EffectAttempt is not eligible for \
           abandoned-claim recovery and follows Receipt reconciliation instead': the \
           eligibility half is carried as AgentCore.NoEffectAttemptFor over the previous \
           claim's ordinal. The alternative path is C13-EFFECT-RECONCILIATION, which \
           C13_EFFECT_WRITE_AHEAD records as unclaimed because the model has no re-query",
          "'abandoned' as a fact about the previous worker. The model has no worker \
           liveness, no heartbeat, and no ownership handover, so what the sentence \
           carries is the recorded expiry being at or before the stated time and the new \
           claim naming a different AgentCore.ClaimWorkerId",
          "the replacement claim is existential in the sentence: nothing fixes which \
           replacement a recovery installs beyond the recorded constraints on it, because \
           AgentCore.EffectLabel.recoverItemClaim does not carry the replacement's id" ] },
    { key := "C13_ATTEMPT_ORDINAL_AFTER_FAILURE"
      atoms := ["C13-ATTEMPT-ORDINAL-AFTER-FAILURE"]
      specSection := "7.4"
      anchor := "SPEC.md:3171"
      digest := "4af054163d16aa021f81fca34463d0923ee3026381cd381215655231e6de9c61"
      sentence :=
        "every claim step establishes an advanced failed ordinal for the claimed item and \
         every claim retry requires a prior failed receipt for the claim retry"
      dropped :=
        [ "'the attempt is appended in the same guarded transaction that admits it': the \
           model has one step per label and no transaction boundary, so there is nothing \
           to quantify over. The sentence carries the two guards separately — the ordinal \
           a claim may take, and the prior final failure a retry attempt requires",
          "'Pre-effect policy may terminalize an unclaimed item': a MAY, and the \
           pre-effect Receipt path is not claimed by either clause",
          "'A final Receipt clears the claim; succeeded terminalizes the item while \
           failed permits the next ordinal'. \
           AgentCore.first_attempt_receipt_clears_only_final_claim and \
           AgentCore.superseding_final_receipt_clears_claim prove the clearing half of \
           the model; this sentence does not claim it",
          "'These rules apply to index 0 of a single too, and prevent two executors from \
           continuing one item': a claim about the rule's scope and about concurrent \
           executors, neither of which the model represents",
          "the retry postcondition — that the retry attempt's ordinal is exactly one \
           above the prior attempt's and that the retry is owned by the item's exact \
           current claim — is proved by \
           AgentCore.retry_uses_exact_current_claim_and_advances_ordinal and is not \
           claimed here. A payload-indexed postcondition takes one key type and \
           AgentCore.EffectLabel.retryAttempt carries two AttemptIds, so relating the \
           prior attempt's ordinal to the retry's is a form the grammar cannot build" ] },
    { key := "C13_EFFECT_WRITE_AHEAD"
      atoms := ["C13-EFFECT-WRITE-AHEAD", "C13-EFFECT-SUPERSEDING-RECEIPT"]
      specSection := "7.4"
      anchor := "SPEC.md:3198"
      digest := "bf3a4bce573c6bf89de55a9ff61a4ceefc8b33997a7c12deb45cf26ca8a8218c"
      sentence :=
        "every attempt receipt establishes a recorded prior attempt for the attempt \
         receipt and every receipt supersession requires an unsuperseded indeterminate \
         receipt for the superseded receipt and additionally every receipt supersession \
         establishes a same attempt final receipt for the receipt supersession"
      dropped :=
        [ "'For mediated external effects, intent and EffectAttempt evidence MUST precede \
           the effect'. THE SENTENCE IS WEAKER THAN THE ATOM. The model has no external \
           call and no effect boundary, so nothing orders a recorded attempt against an \
           effect crossing one. What the first clause carries is the recorded-evidence \
           half: an attempt Receipt is admitted only where the attempt it names is \
           already in the ledger, is that item's latest attempt, and the item holds no \
           current Receipt yet. A green bridge here is not evidence for the atom's \
           ordering claim",
          "'The call MUST carry the item's idempotency key'. C13-EFFECT-IDEMPOTENCY is \
           NOT CLAIMED by this corpus unit. AgentCore.EffectAttempt carries an ItemKey \
           and AgentCore.AttemptMatches ties it to the prepared item, but the model has \
           no call to carry anything, so every rendering would be a claim about the \
           attempt record rather than about the call the atom is about",
          "'reconciliation re-queries that same attempt by idempotency key and appends \
           its superseding final Receipt'. C13-EFFECT-RECONCILIATION is NOT CLAIMED. The \
           model has no re-query, no reconciler, and no external state to query, so \
           neither the trigger nor the mechanism is statable; the third clause carries \
           only the shape a supersession has once it is written",
          "'If its result is not known, the pipeline appends indeterminate': the model \
           admits an indeterminate attempt Receipt but has no notion of a result being \
           unknown, so the condition under which indeterminate is the correct outcome is \
           unrepresentable",
          "'A resend after final failure is a new EffectAttempt through the normal \
           mediated path, never an unrecorded reconciler action': the retry path is \
           C13_ATTEMPT_ORDINAL_AFTER_FAILURE's second clause, and 'never an unrecorded \
           action' is a claim about actions outside the ledger, which a ledger-relative \
           model cannot state",
          "'Eventual reconciliation depends only on the external liveness assumptions \
           stated in §14': a liveness claim. The model is a safety model with no \
           fairness assumption",
          "the third clause reads both Receipts off the post-state rather than across the \
           step, because a supersession writes only the successor and leaves the \
           predecessor's indeterminate record untouched. The one-time half — that the \
           predecessor was not already superseded — is what the second clause carries, as \
           a precondition; AgentCore.supersession_at_most_once is the same fact in \
           refusal form" ] } ]

end SpecCnl.Corpus.Units.Claims
