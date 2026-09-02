import SpecCnl.Unit

/-!
# RunSettle: reviewed pairings for §5.2

The rule units here are about the four records a Run's settlement rests on: the durable
`RunAdmissionRegistry` every remotely-visible obligation is reserved in before it is
admitted, the acceptance verdicts a criterion earns against an exact head tree digest,
the terminal snapshot terminalization captures, and the derived `Settled` predicate that
reads that snapshot back. Terminalization is one transaction — close the registry, advance
its epoch, capture exactly `reserved − completed`, fence the Turn, force-cancel any live
sibling — so the same paragraph appears in more than one rule unit and each sentence below
carries the half its atom names.

Three weaknesses run through the whole group.

* **The step's environment is not visible to a condition.** `AgentCore.GraphStep` takes an
  `EffectLedger`, an `EventStore` and an `AuditLog` as parameters; a condition on a source
  state and a label receives neither. Every clause that would read a Receipt, a delivery or
  an AuditRecord — the `administer` control Receipt that authorizes terminalization, the
  declared-verifier Receipt behind a verdict — is therefore dropped rather than approximated.
* **Refusals are carried as the preconditions every admitted step satisfies.** The model has
  no rejection path, so "MUST NOT run the verifier again" and "an unreserved identity cannot
  complete" become conditions on the transitions that do exist. The negative-form theorem is
  cited on every record where that swap is made.
* **Settlement is not a transition.** `AgentCore.Settled` is a predicate over a
  `SystemState`, so the settled-run rules are rendered with the `every <CN> <VP>` form rather
  than with a transition connective, and the biconditional in "Settled exactly when" is
  carried only left to right.

Four of this group's nine rule units are **not** bridged, and no sentence here pretends to
carry them. `C13-RUN-RESOURCE-CEILING`, `C13-RUN-CEILING-EXHAUSTION`,
`C13-RUN-CEILING-REMAINDER` and `C13-RUN-CEILING-COST` all quantify over a `ResourceCeiling`
record with declared dimensions and over the per-Run running totals a host accumulates for
them. `AgentCore` has no `ResourceCeiling`, no `SpawnReservation` and no spawn attenuation
carrying one: `AgentCore.GraphLabel.spawnChild` carries a parent Turn, a child `RunId` and a
root `CommitId` and nothing else, `AgentCore.Run` has no allowance or remainder field, and
the model has no `tokens`, `costMicros`, `depth`, `wallClockMs` or terminal `exhausted`
field anywhere — `AgentCore.RunStatus` is `active | terminal`, and there is no
`RunLifecycle` record. A ceiling comparison, a remainder derivation and an exhaustion
outcome therefore have nothing to range over, and inventing the record would be authoring
the relation for the bridge.
-/

namespace SpecCnl.Corpus.Units.RunSettle

def units : List RuleUnit :=
  [ { key := "C13_RUN_ADMISSION_REGISTRY"
      atoms := ["C13-RUN-ADMISSION-REGISTRY", "C13-RUN-RESERVATION-EPOCH"]
      specSection := "5.2"
      anchor := "SPEC.md:1535"
      digest := "df064125682d932d333e38a5b03cb8d13550dae495874dd2ac41abd2dbdc6b76"
      sentence :=
        "every obligation completion requires a reserved obligation for the completed \
         obligation and every obligation reservation establishes a valid admission \
         reservation for the reserved obligation"
      dropped :=
        [ "'Before any Run-associated Approval, Invocation item, RouteReservation, \
           reconciliation, or required system commit is admitted locally or remotely, the \
           Run-owning Actor MUST reserve its canonical RunObligation': the admission side \
           lives on the mediated plane as AgentCore.AdmissionRequest.ReservedFor, and no \
           AgentCore.GraphStep relates an admission to a reservation, so the sentence \
           carries the two registry-side rules instead — a completion requires the exact \
           reserved identity, and a reservation yields a reservation valid in the registry \
           it was taken against",
          "the enumeration of reservable identities — ApprovalId, InvocationId plus item \
           index and item key, RouteReservationId, EffectAttemptId for reconciliation, \
           planned RunCommitId — and the matching prohibition 'Receipt, delivery, \
           projection, and Audit ids are never reserved': AgentCore.OpenObligation has \
           exactly those five constructors and acceptance, so both halves hold by \
           construction and a rendering would discriminate nothing",
          "'Duplicate canonical keys reuse the existing reservation': \
           AgentCore.GraphStep.reserveObligation refuses a duplicate outright — \
           `obligation ∉ registry.reserved` is one of its premises — so the model has no \
           reuse path to render. What it does give is that no identity is entered twice, \
           which is a weaker fact than idempotent reuse",
          "'Completion atomically adds that exact reserved identity to completed' as a \
           post-state claim. THE FIRST CLAUSE IS THE REFUSAL HALF ONLY: it says every \
           admitted completion names an already-reserved identity, which is \
           'an unreserved identity cannot complete' in contrapositive. \
           AgentCore.completed_obligation_is_reserved is where the added-to-completed half \
           lives",
          "'Every remote actor validates the exact RunAdmissionReservation identity': the \
           model has no remote actor and no second validation step, so the remote half is \
           unrepresentable. AgentCore.AdmissionReservation.ValidIn — an accepting registry \
           at the reservation's exact epoch holding its obligation reserved and not \
           completed — is what the second clause claims, and it is the epoch binding \
           C13-RUN-RESERVATION-EPOCH is about",
          "the acceptance carve-out from both generic paths: \
           AgentCore.generic_reservation_refuses_acceptance and \
           AgentCore.generic_completion_refuses_acceptance are negative existentials over a \
           step, and the grammar has no form for the non-existence of a transition" ] },
    { key := "C13_RUN_ACCEPTANCE_SUBJECT"
      atoms := ["C13-RUN-ACCEPTANCE-SUBJECT"]
      specSection := "5.2"
      anchor := "SPEC.md:1768"
      digest := "342e643d28477ccdf93e24e6e4c730df7c30660b0c8fc0474881102257bdce60"
      sentence :=
        "every verdict recording requires an unrecorded subject for the verdict and every \
         system state refuses acceptance without a head verdict"
      dropped :=
        [ "'While a criterion holds a verdict naming the current head tree digest, that \
           verdict is current evidence and the system MUST NOT run the verifier again' as a \
           refusal: the model has no rejection path, so the first clause carries the \
           precondition every admitted recording satisfies — the subject is one no recorded \
           verdict for that criterion names. AgentCore.acceptance_current_verdict_blocks_retry \
           and AgentCore.recorded_verdict_blocks_repeat_verdict_step are the refusal forms, \
           and they are what makes that precondition unsatisfiable once a verdict stands",
          "'so what makes a retry possible is changed input rather than elapsed time or a \
           counted attempt': the model has no attempt counter and no clock on acceptance, so \
           the contrast has nothing to range over. The sentence carries the positive half, \
           that admissibility is decided by the subject alone",
          "'A Run therefore cannot spin against inputs it has not moved, and one that keeps \
           failing is visible as a criterion undischarged across distinct subjects': a claim \
           about what an operator observes across a whole Run rather than a property of one \
           state or one step",
          "the second clause is a claim about a SystemState rather than about a graph, \
           because AgentCore.AcceptanceSatisfied reads an EffectLedger that \
           AgentCore.GraphStore does not contain. It reads the state's own ledger, so \
           quantifying over every state ranges over every graph-and-ledger pair, and what \
           it asserts of each is what AgentCore.acceptance_verdict_only_for_its_subject \
           states: a criterion is unsatisfied at a head tree no recorded verdict for it \
           names, whatever subjects its earlier verdicts named",
          "'system state' is a type-as-common-noun entry whose denotation is `fun _ => True`, \
           so the noun refuses no wrong subject and the second clause's whole force is its \
           universal quantification",
          "the head-tree functionality half of §5.2 acceptance, which \
           C13_RUN_ACCEPTANCE_OBLIGATION already carries as 'the head tree assigns at most \
           one value', and the declared-verifier binding on a recorded verdict, which is \
           that unit's dropped clause and remains AgentCore.VerifierReceipt inside a step \
           premise no condition can read" ] },
    { key := "C13_RUN_FORCED_CANCELLATION"
      atoms := ["C13-RUN-FORCED-CANCELLATION"]
      specSection := "5.2"
      anchor := "SPEC.md:1550"
      digest := "b8a4d3ca40392de0328407bc933f1f4cbddd19e2f1c81b3b2c20a9f1aab15336"
      sentence :=
        "every sibling cancellation establishes a fenced cancelled sibling for the \
         cancelled sibling and every run terminalization requires terminal unheld siblings \
         for the terminalized run"
      dropped :=
        [ "'Every sibling Turn MUST already be both terminal and unheld, or, only while this \
           terminalization is open, the system MUST force-cancel it' as one disjunction: the \
           grammar has no sentence-level disjunction, so the two clauses carry the two sides \
           apart — terminalization admits only terminal unheld siblings, and forced \
           cancellation is the step that makes a live sibling one",
          "the rest of the terminalization transaction — 'close the admission registry, \
           advance its epoch, snapshot exactly reserved − completed, append the terminal \
           result commit under the exact current Turn token, record the Run outcome, and \
           capture one finite SettlementObligation'. The registry close, the epoch advance \
           and the snapshot are carried by C13_RUN_FRONTIER_COMPLETE in this group; the \
           terminal commit's shape is AgentCore.terminal_snapshot_is_coherent, and the \
           exact-current-Turn-token half is \
           AgentCore.terminalization_requires_current_turn_pins with \
           AgentCore.migrated_old_turn_cannot_terminalize as its refusal",
          "'One exact successful administer control Receipt and its matching AuditRecord \
           authorize the sequence': AgentCore.TerminalizationControl.Valid reads the \
           EffectLedger and the AuditLog, which are parameters of AgentCore.GraphStep rather \
           than fields of AgentCore.GraphStore, so no condition on a source state and a \
           label can mention them",
          "'The sibling MUST be a distinct Turn in the same Run': the forceCancelSibling \
           premises `terminalTurnId ≠ siblingId` and `sibling.run = runId` enforce it, and \
           both Turn ids are label components rather than state, so a rendering would \
           restate the label the sentence already quantifies over",
          "'appends token-scoped turn.cancel inbox and Audit evidence': the model records \
           AgentCore.ForcedCancellation with its control and cancellation audit ids and has \
           no inbox at all, so the inbox half is unrepresentable and the sentence carries \
           the recorded evidence",
          "'only while this terminalization is open' as a window: \
           AgentCore.GraphStore.terminalizing holds the open control and the step reads it, \
           but the clause the sentence carries is about what a cancellation leaves behind, \
           not about the window it sits in",
          "AgentCore.forced_cancellation_unblocks_undo, which reads the same postcondition \
           as the release that lets a later undo append; it is a consequence of the clause \
           carried here rather than a separate claim" ] },
    { key := "C13_RUN_FRONTIER_COMPLETE"
      atoms := ["C13-RUN-FRONTIER-COMPLETE", "C13-RUN-FRONTIER-EMPTY"]
      specSection := "5.2"
      anchor := "SPEC.md:1561"
      digest := "8f92d2ae0f48318632d7d99646214b683bdc47aeda28e7039aa088f43af564fc"
      sentence :=
        "every run terminalization establishes an exact closed frontier for the \
         terminalized run"
      dropped :=
        [ "the enumeration 'all pending Approvals, admitted Invocation items without a \
           terminal current Receipt, RouteReservations without terminal delivery, \
           EffectAttempts requiring reconciliation, and required system commits': the \
           captured set is the just-closed registry's reserved-minus-completed set whatever \
           those identities are, and AgentCore.OpenObligation's constructors are the \
           enumeration, so a rendering would hold by construction",
          "'not a remote discovery query': the model has no discovery query to exclude. The \
           sentence states the positive identity the exclusion protects — the captured set \
           is a function of the pre-state registry alone",
          "'The finite registry MAY honestly be empty when no reservation was admitted; \
           empty does not mean discovery was skipped' as a permission: a MAY constrains no \
           transition. C13-RUN-FRONTIER-EMPTY is carried through the biconditional, which \
           fixes an empty snapshot exactly when nothing is outstanding rather than treating \
           empty as a failure to look, and \
           AgentCore.run_start_reserves_exactly_declared_acceptance with \
           AgentCore.spawn_child_reserves_exactly_declared_acceptance are where a Run that \
           declares no criterion is shown to open a registry with nothing but its declared \
           acceptance in it",
          "'It contains no completed or unreserved work' as a separate clause: it is the \
           right-to-left direction of the biconditional the sentence already carries",
          "AgentCore.terminal_snapshot_captures_complete_frontier, which states the same \
           capture as AgentCore.CompleteAdmittedFrontier over the pre-state registry; the \
           membership biconditional the sentence carries is the elementwise form of that \
           equality, and neither states that the captured list is duplicate-free" ] },
    { key := "C13_RUN_SETTLED_DERIVED"
      atoms := ["C13-RUN-SETTLED-DERIVED"]
      specSection := "5.2"
      anchor := "SPEC.md:1576"
      digest := "5f8ffba12f0d37058838164fb5b37f8feedfc47693e673e89a6a00f0b2c949ac"
      sentence :=
        "every settled system state captures a coherent terminal snapshot and every settled \
         system state discharges its captured obligations"
      dropped :=
        [ "the definition's clause-by-clause content — 'every captured Invocation item has a \
           terminal current Receipt, no indeterminate Receipt is current, every captured \
           RouteReservation has delivery or terminal rejection evidence, and every captured \
           system RunCommit exists', the audit obligation resolving to an AuditRecord whose \
           typed causal chain reaches that exact evidence, the Approval resolution and the \
           reconciliation resolution. Each is one case of AgentCore.ObligationDischarged, so \
           the sentence carries them wholesale through that predicate rather than clause by \
           clause: a wrong case inside it would not fail this bridge",
          "'Settled is derived, never assigned': AgentCore.Settled is a predicate over a \
           SystemState and no transition writes it, so the negative half is a property of \
           the signature rather than a statable claim",
          "'Terminal does not assert all asynchronous evidence has arrived' as a distinction \
           between terminal and settled: the sentence says what settlement gives, not what \
           terminality withholds. AgentCore.acceptance_unsatisfied_not_settled is the \
           model's statement of the gap, and it is a negative the grammar cannot form",
          "'exactly when' as a biconditional. THE SENTENCE CARRIES ONLY THE LEFT-TO-RIGHT \
           DIRECTION. A green bridge here is not evidence that a Run meeting every listed \
           condition is Settled; the converse would need every conjunct of AgentCore.Settled \
           as a hypothesis, and the grammar has no form for a sentence whose subject carries \
           a dependent witness",
          "AgentCore.settled_run_acceptance_holds_at_current_head and its reachable-graph \
           form, which resolve a settled Run's acceptance obligations to verdicts at the \
           Run's current head. Both take the four graph invariants as premises — outstanding \
           acceptance, unique criteria, earned verdicts, snapshot-registry agreement — and \
           the grammar has no form for a premised sentence" ] } ]

end SpecCnl.Corpus.Units.RunSettle
