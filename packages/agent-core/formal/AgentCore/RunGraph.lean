import AgentCore.Audit

/-!
# Pinned writer-validated Run graph

Every commit carries exact-source RunPins. Unary commits inherit pins, migration is an
audited admin-controlled pin change, and merges require equal pins from two unique
current branch heads. Root and Turn writers carry audit causes. System cancellation
fences without impersonating a Turn writer. Terminalization records outcome, fences the
exact Turn, excludes other live Turns, and snapshots the complete admitted unfinished
frontier, which may honestly be empty. Settlement is not a stored Run status or commit.
-/

namespace AgentCore

structure PackagePin where
  package : PackageId
  version : Nat
  manifestDigest : Nat
  codeDigest : Nat
  deriving DecidableEq, Repr
structure EnvironmentId where value : Nat deriving DecidableEq, Repr
structure PolicySetId where value : Nat deriving DecidableEq, Repr
structure ModelPolicyId where value : Nat deriving DecidableEq, Repr
structure BlueprintPin where
  id : BlueprintId
  version : Nat
  digest : Nat
  deriving DecidableEq, Repr
structure AgentPin where
  id : AgentId
  revision : Nat
  digest : Nat
  deriving DecidableEq, Repr
structure EffectivePolicyPin where
  id : PolicySetId
  revision : Nat
  digest : Nat
  deriving DecidableEq, Repr
structure ModelPolicyPin where
  id : ModelPolicyId
  revision : Nat
  digest : Nat
  deriving DecidableEq, Repr
structure EnvironmentPin where
  id : EnvironmentId
  revision : Nat
  digest : Nat
  deriving DecidableEq, Repr
structure RunPins where
  blueprint : BlueprintPin
  packageClosure : List PackagePin
  agent : AgentPin
  effectivePolicy : EffectivePolicyPin
  modelPolicy : ModelPolicyPin
  environment : EnvironmentPin
  deriving DecidableEq, Repr

def RunPins.Valid (pins : RunPins) (agent : AgentId) : Prop :=
  pins.agent.id = agent ∧ pins.packageClosure ≠ [] ∧
    (pins.packageClosure.map PackagePin.package).Nodup

structure TurnPins where
  runPins : RunPins
  placement : PlacementSnapshot
  deriving DecidableEq, Repr

inductive RunStatus where | active | terminal deriving DecidableEq, Repr
inductive TurnStatus where | queued | running | suspended | succeeded | failed | cancelled
  deriving DecidableEq, Repr

/-- An acceptance criterion a Run declares when it opens: an ordinary Operation that
    decides whether the work is done (§5.2). -/
structure AcceptanceCriterion where
  id : AcceptanceId
  operation : OperationId
  deriving DecidableEq, Repr

/-- An acceptance verdict earned by the verifier: it names the head tree digest the
    verifier saw and the attempted Receipt that carries the §7 admission and audit chain. -/
structure AcceptanceVerdict where
  acceptance : AcceptanceId
  subject : TreeId
  receipt : ReceiptId
  deriving DecidableEq, Repr

/-- A Run declares its acceptance criteria when it opens and never afterwards, so the
    declared set is part of the Run record rather than a table anything can rewrite. -/
structure Run where
  tenant : TenantId
  workspace : WorkspaceId
  agent : AgentId
  pins : RunPins
  root : CommitId
  rootBranch : BranchId
  parent : Option RunId
  status : RunStatus
  acceptance : List AcceptanceCriterion
  deriving DecidableEq, Repr

structure Turn where
  run : RunId
  branch : BranchId
  pins : TurnPins
  status : TurnStatus
  lease : TurnLease
  deriving DecidableEq, Repr

structure ForcedCancellation where
  run : RunId
  terminalTurn : TurnId
  turn : TurnId
  priorLeaseEpoch : Nat
  fencedLeaseEpoch : Nat
  controlReceipt : ReceiptId
  controlAudit : AuditId
  cancellationAudit : AuditId
  deriving DecidableEq, Repr

def Turn.withStatusLease (turn : Turn) (status : TurnStatus) (lease : TurnLease) : Turn :=
  { turn with status := status, lease := lease }

structure RunBranch where run : RunId deriving DecidableEq, Repr

inductive ConversationResolution where
  | pick (parent : CommitId) (controlReceipt : ReceiptId)
  | concatenate (controlReceipt : ReceiptId)
  | synthesize (operation : OperationId) (controlReceipt synthesisReceipt : ReceiptId)
      (token : LeaseToken) (result : InvocationIdentity)
  deriving DecidableEq, Repr

inductive TreeResolution where
  | clean (tree : TreeId)
  | blocked (head : String) (tail : List String)
  deriving DecidableEq, Repr

inductive RunCommitKind where
  | root | message | checkpoint | terminal (outcome : ReceiptOutcome)
  | invocationEvidence (operation : OperationId) (receipt : ItemReceiptRef) (outcome : ItemOutcome)
  | deliveryEvidence (operation : OperationId) (reservation : ReservationId)
      (outcome : RouteDeliveryOutcome)
  | control (operation : OperationId) (receipt : ReceiptId)
  | migration (pins : RunPins) (operation : OperationId) (controlReceipt : ReceiptId)
  | undo (selects : CommitId) (controlReceipt : ReceiptId)
  | merge (conversation : ConversationResolution) (tree : TreeResolution)
  deriving DecidableEq, Repr

inductive SystemCause where
  | receipt (audit : AuditId) (receipt : ItemReceiptRef)
  | delivery (audit : AuditId) (reservation : ReservationId)
  | control (audit : AuditId) (receipt : ReceiptId)
  deriving DecidableEq, Repr

inductive CommitWriter where
  | root (auditCause : AuditId)
  | turn (token : LeaseToken) (auditCause : AuditId)
  | system (cause : SystemCause)
  deriving DecidableEq, Repr

/-- `treeCheckpoint` is the tree this commit leaves at its branch head, when it leaves one;
    the Run's head tree digest is read off it, so acceptance subjects are trees the Run's own
    commit graph produced rather than free-floating digests. -/
structure RunCommit where
  run : RunId
  branch : BranchId
  pins : RunPins
  writer : CommitWriter
  parents : List CommitId
  subjectTurn : Option TurnId
  kind : RunCommitKind
  treeCheckpoint : Option TreeId
  deriving DecidableEq, Repr

inductive OpenObligation where
  | approval (id : ApprovalId)
  | item (invocation : InvocationId) (index : Nat) (key : ItemKey)
  | route (reservation : ReservationId)
  | reconciliation (attempt : AttemptId)
  | systemCommit (commit : CommitId)
  | acceptance (id : AcceptanceId)
  deriving DecidableEq, Repr

/-- The generic reserve and complete paths serve every obligation kind uniformly, which is
    exactly why acceptance has to be carved out of them: an acceptance obligation is reserved
    when the Run declares it at open and is never completed at all, so a uniform completion
    would retire one with no verdict behind it and settle the Run on nothing. -/
def OpenObligation.NotAcceptance : OpenObligation → Prop
  | .acceptance _ => False
  | _ => True

structure TerminalSnapshot where
  run : RunId
  turn : TurnId
  preterminal : CommitId
  terminalCommit : CommitId
  outcome : ReceiptOutcome
  registryEpoch : Nat
  obligations : List OpenObligation
  deriving DecidableEq, Repr

structure RunAdmissionRegistry where
  epoch : Nat
  accepting : Bool
  reserved : List OpenObligation
  completed : List OpenObligation
  deriving DecidableEq, Repr

structure AdmissionReservation where
  run : RunId
  epoch : Nat
  obligation : OpenObligation
  deriving DecidableEq, Repr

def RunAdmissionRegistry.reserve (registry : RunAdmissionRegistry)
    (obligation : OpenObligation) : RunAdmissionRegistry :=
  { registry with reserved := registry.reserved ++ [obligation] }

def RunAdmissionRegistry.complete (registry : RunAdmissionRegistry)
    (obligation : OpenObligation) : RunAdmissionRegistry :=
  { registry with completed := registry.completed ++ [obligation] }

def RunAdmissionRegistry.outstanding (registry : RunAdmissionRegistry) : List OpenObligation :=
  registry.reserved.filter (fun obligation => obligation ∉ registry.completed)

def RunAdmissionRegistry.close (registry : RunAdmissionRegistry) : RunAdmissionRegistry :=
  { registry with epoch := registry.epoch + 1, accepting := false }

structure TerminalizationControl where
  turn : TurnId
  receipt : ReceiptId
  audit : AuditId
  deriving DecidableEq, Repr

structure GraphStore where
  runs : RunId → Option Run
  branches : BranchId → Option RunBranch
  turns : TurnId → Option Turn
  commits : CommitId → Option RunCommit
  heads : BranchId → Option CommitId
  admissionRegistry : RunId → Option RunAdmissionRegistry
  terminalSnapshots : RunId → Option TerminalSnapshot
  forcedCancellations : TurnId → Option ForcedCancellation
  terminalizing : RunId → Option TerminalizationControl
  acceptanceVerdicts : AcceptanceId → List AcceptanceVerdict
  conflicts : RunId → Prop

instance : Inhabited GraphStore where
  default := ⟨fun _ => none, fun _ => none, fun _ => none, fun _ => none,
    fun _ => none, fun _ => none, fun _ => none, fun _ => none, fun _ => none,
    fun _ => [], fun _ => False⟩

/-- The criteria a Run declared at open. Nothing else can name one, and no transition can
    add one afterwards. -/
def GraphStore.acceptanceCriteria (store : GraphStore) (run : RunId) : List AcceptanceCriterion :=
  match store.runs run with
  | none => []
  | some record => record.acceptance

/-- An `AcceptanceId` names one criterion across the whole store, so opening a Run that
    redeclares an identity some Run already declared is refused. -/
def GraphStore.DeclaresAcceptance (store : GraphStore) (accId : AcceptanceId) : Prop :=
  ∃ runId criterion, criterion ∈ store.acceptanceCriteria runId ∧ criterion.id = accId

/-- `store.HeadTree run tree` reads the Run's current head tree off the graph: the tree
    checkpoint of the Run's own commit at the head of its root branch. It is functional in
    `tree` and moves whenever the Run appends a checkpointing commit to that branch. -/
def GraphStore.HeadTree (store : GraphStore) (run : RunId) (tree : TreeId) : Prop :=
  ∃ record head commit,
    store.runs run = some record ∧ store.heads record.rootBranch = some head ∧
    store.commits head = some commit ∧ commit.run = run ∧ commit.treeCheckpoint = some tree

/-- A further verifier attempt is admissible only against a subject that no recorded
    verdict for the criterion names; changed input, never elapsed time, unblocks it (§5.2). -/
def GraphStore.AcceptanceRetryAdmissible (store : GraphStore) (accId : AcceptanceId)
    (subject : TreeId) : Prop :=
  ∀ verdict ∈ store.acceptanceVerdicts accId, verdict.acceptance = accId →
    verdict.subject ≠ subject

def GraphStore.recordVerdict (store : GraphStore) (verdict : AcceptanceVerdict) : GraphStore :=
  { store with
    acceptanceVerdicts := fun candidate =>
      if candidate = verdict.acceptance then verdict :: store.acceptanceVerdicts candidate
      else store.acceptanceVerdicts candidate }

/-- The Receipt a verdict names must be an attempted Receipt of the criterion's own declared
    verifier Operation, with the stated outcome. Without the Operation binding the declared
    verifier would be decoration and any succeeded Receipt would discharge any criterion. -/
def VerifierReceipt (effects : EffectLedger) (receiptId : ReceiptId) (verifier : OperationId)
    (outcome : AttemptOutcome) : Prop :=
  ∃ receipt attempt prepared,
    effects.attemptReceipts receiptId = some receipt ∧ receipt.outcome = outcome ∧
    effects.attempts receipt.attempt = some attempt ∧
    effects.invocations attempt.invocation = some prepared ∧
    prepared.header.operation = verifier

/-- A `ReceiptId` resolves through the ledger by lookup alone, so it determines both the
    Operation behind it and its outcome. -/
theorem verifier_receipt_is_functional {effects receiptId}
    {leftVerifier rightVerifier : OperationId} {leftOutcome rightOutcome : AttemptOutcome}
    (left : VerifierReceipt effects receiptId leftVerifier leftOutcome)
    (right : VerifierReceipt effects receiptId rightVerifier rightOutcome) :
    leftVerifier = rightVerifier ∧ leftOutcome = rightOutcome := by
  obtain ⟨receipt, attempt, prepared, receiptLookup, outcome, attemptLookup, invocationLookup,
    operation⟩ := left
  obtain ⟨_, _, _, receiptLookup', outcome', attemptLookup', invocationLookup', operation'⟩ := right
  rw [receiptLookup] at receiptLookup'
  cases Option.some.inj receiptLookup'
  rw [attemptLookup] at attemptLookup'
  cases Option.some.inj attemptLookup'
  rw [invocationLookup] at invocationLookup'
  cases Option.some.inj invocationLookup'
  exact ⟨operation.symm.trans operation', outcome.symm.trans outcome'⟩

/-- Settlement's own test of an acceptance obligation, mirroring `acceptanceSatisfied`: the
    criterion holds a recorded verdict whose subject is the Run's *current* head tree and whose
    named attempt Receipt succeeded. It does not re-read the criterion's declared Operation,
    because the implementation does not either — that binding is established when the verdict
    is recorded and carried forward by `AcceptanceVerdictsEarned` (§5.2). -/
def AcceptanceSatisfied (store : GraphStore) (effects : EffectLedger) (run : RunId)
    (accId : AcceptanceId) : Prop :=
  ∃ subject verdict verifier,
    store.HeadTree run subject ∧
    verdict ∈ store.acceptanceVerdicts accId ∧
    verdict.acceptance = accId ∧ verdict.subject = subject ∧
    VerifierReceipt effects verdict.receipt verifier .succeeded

def AdmissionReservation.ValidIn (reservation : AdmissionReservation)
    (store : GraphStore) : Prop :=
  ∃ registry, store.admissionRegistry reservation.run = some registry ∧
    registry.accepting = true ∧ registry.epoch = reservation.epoch ∧
    reservation.obligation ∈ registry.reserved ∧
    reservation.obligation ∉ registry.completed

def GraphStore.append (store : GraphStore) (id : CommitId) (commit : RunCommit) : GraphStore := {
  store with
  commits := tableSet store.commits id commit
  heads := tableSet store.heads commit.branch id
}

/-- The commit a branch is *effectively* at: its head, unless the head is an undo commit, in
    which case the commit that undo selects. Appending an undo advances the head like any
    other commit -- the graph is append-only -- and moves the effective state to the selected
    ancestor without rewinding, rewriting, or dropping anything (§5.2). -/
def GraphStore.effectiveState (store : GraphStore) (branch : BranchId) : Option CommitId :=
  match store.heads branch with
  | none => none
  | some head =>
      match store.commits head with
      | none => none
      | some commit =>
          some (match commit.kind with
            | .undo selected _ => selected
            | _ => head)

def GraphStore.reserve (store : GraphStore) (run : RunId)
    (registry : RunAdmissionRegistry) (obligation : OpenObligation) : GraphStore :=
  let updated := registry.reserve obligation
  { store with admissionRegistry := tableSet store.admissionRegistry run updated }

def GraphStore.complete (store : GraphStore) (run : RunId)
    (registry : RunAdmissionRegistry) (obligation : OpenObligation) : GraphStore :=
  let updated := registry.complete obligation
  { store with admissionRegistry := tableSet store.admissionRegistry run updated }

inductive Ancestor (store : GraphStore) : CommitId → CommitId → Prop
  | refl {id commit} : store.commits id = some commit → Ancestor store id id
  | parent {ancestor child commit parent} :
      store.commits child = some commit → parent ∈ commit.parents →
      Ancestor store ancestor parent → Ancestor store ancestor child

def ParentsClosed (store : GraphStore) (commit : RunCommit) : Prop :=
  ∀ parent, parent ∈ commit.parents →
    ∃ record, store.commits parent = some record ∧ record.run = commit.run

def UnaryPinsInherited (store : GraphStore) (commit : RunCommit) : Prop :=
  ∃ parent record, commit.parents = [parent] ∧ store.commits parent = some record ∧
    commit.pins = record.pins

def CurrentMergeHeads (store : GraphStore) (commit : RunCommit) (expected : CommitId) : Prop :=
  ∃ sourceBranch sourceHead destination source,
    sourceBranch ≠ commit.branch ∧
    store.heads commit.branch = some expected ∧ store.heads sourceBranch = some sourceHead ∧
    expected ≠ sourceHead ∧ commit.parents = [expected, sourceHead] ∧
    store.commits expected = some destination ∧ store.commits sourceHead = some source ∧
    destination.run = commit.run ∧ source.run = commit.run ∧
    destination.pins = commit.pins ∧ source.pins = commit.pins

def AuditCauseExists (audit : AuditLog) (cause : AuditId) (run : RunId) : Prop :=
  ∃ entry, audit.entries cause = some entry ∧ entry.actor = .run (actorTenantOf entry.actor) run

def TurnWriterValid (store : GraphStore) (audit : AuditLog) (commit : RunCommit)
    (token : LeaseToken) (cause : AuditId) (now : Time) : Prop :=
  ∃ turn, store.turns token.turn = some turn ∧ turn.run = commit.run ∧
    turn.branch = commit.branch ∧ turn.pins.runPins = commit.pins ∧ turn.status = .running ∧
    turn.lease.Admits token now ∧ AuditCauseExists audit cause commit.run

def ReceiptEvidence (effects : EffectLedger) (prepared : PreparedInvocation)
    (operation : OperationId) (reference : ItemReceiptRef) (outcome : ItemOutcome)
    (run : RunId) (turn : Option TurnId) : Prop :=
  effects.invocations prepared.header.invocation = some prepared ∧
  prepared.header.operation = operation ∧
  (∃ tenant, prepared.header.domain = .run tenant run) ∧
  prepared.header.lease.map LeaseToken.turn = turn ∧
  match reference with
  | .preEffect id => ∃ receipt,
      effects.preReceipts id = some receipt ∧ receipt.invocation = prepared.header.invocation ∧
      ((receipt.outcome = .denied ∧ outcome = .denied) ∨
       (receipt.outcome = .cancelled ∧ outcome = .cancelled))
  | .attempt id => ∃ receipt attempt,
      effects.attemptReceipts id = some receipt ∧ effects.attempts receipt.attempt = some attempt ∧
      attempt.invocation = prepared.header.invocation ∧
      ((receipt.outcome = .succeeded ∧ outcome = .succeeded) ∨
       (receipt.outcome = .failed ∧ outcome = .failed) ∨
       (receipt.outcome = .indeterminate ∧ outcome = .indeterminate))

def SuccessfulControl (effects : EffectLedger) (receiptId : ReceiptId)
    (operation : OperationId) (run : RunId) : Prop :=
  ∃ receipt attempt prepared,
    effects.attemptReceipts receiptId = some receipt ∧ receipt.outcome = .succeeded ∧
    effects.attempts receipt.attempt = some attempt ∧
    effects.invocations attempt.invocation = some prepared ∧
    prepared.header.operation = operation ∧ prepared.header.impact = .administer ∧
    (∃ tenant, prepared.header.domain = .run tenant run)

def TerminalizationControl.Valid (effects : EffectLedger) (audit : AuditLog)
    (run : RunId) (control : TerminalizationControl) : Prop :=
  ∃ operation receipt attempt prepared entry,
    SuccessfulControl effects control.receipt operation run ∧
    audit.entries control.audit = some entry ∧
    effects.attemptReceipts control.receipt = some receipt ∧
    effects.attempts receipt.attempt = some attempt ∧
    effects.invocations attempt.invocation = some prepared ∧
    entry.kind = .attemptReceipt control.receipt receipt.attempt attempt.invocation .succeeded

def SuccessfulSynthesis (effects : EffectLedger) (receiptId : ReceiptId)
    (operation : OperationId) (run : RunId) (token : LeaseToken)
    (result : InvocationIdentity) : Prop :=
  ∃ receipt attempt prepared,
    effects.attemptReceipts receiptId = some receipt ∧ receipt.outcome = .succeeded ∧
    effects.attempts receipt.attempt = some attempt ∧
    effects.invocations attempt.invocation = some prepared ∧
    prepared.header.operation = operation ∧ prepared.header.impact = .execute ∧
    prepared.header.lease = some token ∧ attempt.token = some token ∧
    prepared.identity = result ∧
    (∃ tenant, prepared.header.domain = .run tenant run)

def DeliveryEvidence (effects : EffectLedger) (events : EventStore) (reservation : ReservationId)
    (operation : OperationId) (outcome : RouteDeliveryOutcome) (run : RunId)
    (turn : Option TurnId) : Prop :=
  ∃ route delivery prepared tenant,
    events.reservations reservation = some route ∧ events.deliveries reservation = some delivery ∧
    delivery.outcome = outcome ∧ delivery.targetTurn = turn ∧
    effects.invocations route.invocation = some prepared ∧ prepared.header.operation = operation ∧
    prepared.header.domain = .run tenant run ∧ prepared.header.lease.map LeaseToken.turn = turn

def ReceiptCommitAudit (store : GraphStore) (effects : EffectLedger) (audit : AuditLog)
    (cause : AuditId) (operation : OperationId) (reference : ItemReceiptRef)
    (outcome : ItemOutcome) (run : RunId) (turn : Option TurnId) : Prop :=
  ∃ runRecord entry prepared,
    store.runs run = some runRecord ∧ audit.entries cause = some entry ∧
    entry.actor = .run runRecord.tenant run ∧
    ReceiptEvidence effects prepared operation reference outcome run turn ∧
    match reference with
    | .preEffect id => ∃ receipt,
        effects.preReceipts id = some receipt ∧
        entry.kind = .preReceipt id receipt.invocation receipt.itemIndex receipt.outcome
    | .attempt id => ∃ receipt attempt,
        effects.attemptReceipts id = some receipt ∧
        effects.attempts receipt.attempt = some attempt ∧
        entry.kind = .attemptReceipt id receipt.attempt attempt.invocation receipt.outcome

def DeliveryCommitAudit (store : GraphStore) (effects : EffectLedger) (events : EventStore)
    (audit : AuditLog) (cause : AuditId) (reservation : ReservationId)
    (operation : OperationId) (outcome : RouteDeliveryOutcome) (run : RunId)
    (turn : Option TurnId) : Prop :=
  ∃ runRecord entry route delivery,
    store.runs run = some runRecord ∧ audit.entries cause = some entry ∧
    entry.actor = .run runRecord.tenant run ∧
    events.reservations reservation = some route ∧
    events.deliveries reservation = some delivery ∧ delivery.outcome = outcome ∧
    entry.kind = .delivery reservation route.projection route.invocation outcome ∧
    DeliveryEvidence effects events reservation operation outcome run turn

def ControlCommitAudit (store : GraphStore) (effects : EffectLedger) (audit : AuditLog)
    (cause : AuditId) (receiptId : ReceiptId) (operation : OperationId) (run : RunId) : Prop :=
  ∃ runRecord entry receipt attempt prepared,
    store.runs run = some runRecord ∧ audit.entries cause = some entry ∧
    entry.actor = .run runRecord.tenant run ∧
    effects.attemptReceipts receiptId = some receipt ∧ receipt.outcome = .succeeded ∧
    effects.attempts receipt.attempt = some attempt ∧
    effects.invocations attempt.invocation = some prepared ∧
    prepared.header.operation = operation ∧ prepared.header.impact = .administer ∧
    (∃ tenant, prepared.header.domain = .run tenant run) ∧
    entry.kind = .attemptReceipt receiptId receipt.attempt attempt.invocation .succeeded

/-- A Turn *holds* its branch while it is running under a lease that still names a holder.
    Expiry is deliberately not read: an expired lease is still reclaimable by whoever holds it
    until someone fences it, so elapsed time never releases a branch. Only `suspendFence` and
    `terminalFence` do -- they are the two lease steps that clear the holder while advancing
    the epoch (§5.2, §5.3). -/
def BranchHeldBy (store : GraphStore) (run : RunId) (branch : BranchId) (turn : TurnId) : Prop :=
  ∃ record, store.turns turn = some record ∧ record.run = run ∧ record.branch = branch ∧
    record.status = .running ∧ record.lease.holder ≠ none

/-- No Turn holds the branch. An undo must establish this before it may append, so an undo
    that would orphan an in-flight Turn is refused until that Turn is fenced or completes. -/
def BranchUnheld (store : GraphStore) (run : RunId) (branch : BranchId) : Prop :=
  ∀ turn, ¬ BranchHeldBy store run branch turn

def CommitAllowed (store : GraphStore) (effects : EffectLedger) (events : EventStore)
    (audit : AuditLog) (now : Time) (commit : RunCommit) : Prop :=
  match commit.kind, commit.writer with
  | .root, .root cause => commit.parents = [] ∧ commit.subjectTurn = none ∧
      AuditCauseExists audit cause commit.run
  | .message, .turn token cause | .checkpoint, .turn token cause
  | .terminal _, .turn token cause =>
      UnaryPinsInherited store commit ∧ TurnWriterValid store audit commit token cause now ∧
      commit.subjectTurn = some token.turn
  | .invocationEvidence operation reference outcome, .system (.receipt cause exactReference) =>
      exactReference = reference ∧
      ReceiptCommitAudit store effects audit cause operation reference outcome commit.run
        commit.subjectTurn ∧
      UnaryPinsInherited store commit ∧
      ∃ prepared, ReceiptEvidence effects prepared operation reference outcome commit.run commit.subjectTurn
  | .deliveryEvidence operation reservation outcome, .system (.delivery cause exactReservation) =>
      exactReservation = reservation ∧
      DeliveryCommitAudit store effects events audit cause reservation operation outcome commit.run
        commit.subjectTurn ∧
      UnaryPinsInherited store commit ∧
      DeliveryEvidence effects events reservation operation outcome commit.run commit.subjectTurn
  | .control operation receipt, .system (.control cause exactReceipt) =>
      exactReceipt = receipt ∧ ControlCommitAudit store effects audit cause receipt operation commit.run ∧
      UnaryPinsInherited store commit ∧ SuccessfulControl effects receipt operation commit.run
  | .migration pins operation receipt, .system (.control cause exactReceipt) =>
      exactReceipt = receipt ∧ commit.pins = pins ∧
      ControlCommitAudit store effects audit cause receipt operation commit.run ∧
      SuccessfulControl effects receipt operation commit.run
  | .undo selected receipt, .system (.control cause exactReceipt) =>
      exactReceipt = receipt ∧
      UnaryPinsInherited store commit ∧
      (∃ operation, ControlCommitAudit store effects audit cause receipt operation commit.run ∧
        SuccessfulControl effects receipt operation commit.run) ∧
      BranchUnheld store commit.run commit.branch ∧
      ∃ parent, parent ∈ commit.parents ∧ Ancestor store selected parent
  | .merge (.pick picked receipt) (.clean _), .system (.control cause exactReceipt) =>
      exactReceipt = receipt ∧
      (∃ operation, ControlCommitAudit store effects audit cause receipt operation commit.run ∧
        SuccessfulControl effects receipt operation commit.run) ∧
      picked ∈ commit.parents
  | .merge (.concatenate receipt) (.clean _), .system (.control cause exactReceipt) =>
      exactReceipt = receipt ∧
      ∃ operation, ControlCommitAudit store effects audit cause receipt operation commit.run ∧
        SuccessfulControl effects receipt operation commit.run
  | .merge (.synthesize operation control synthesis token result) (.clean _),
      .system (.control cause exactControl) =>
      exactControl = control ∧
      ControlCommitAudit store effects audit cause control operation commit.run ∧
      SuccessfulControl effects control operation commit.run ∧
      SuccessfulSynthesis effects synthesis operation commit.run token result ∧
      commit.subjectTurn = some token.turn
  | _, _ => False

inductive GraphLabel where
  | startRun (run : RunId) (root : CommitId)
  | startTurn (turn : TurnId) | claimTurn (turn : TurnId) | suspendTurn (turn : TurnId)
  | resumeTurn (turn : TurnId)
  | spawnChild (parentTurn : TurnId) (childRun : RunId) (root : CommitId)
  | append (id expected : CommitId) (commit : RunCommit)
  | migrate (run : RunId) (id expected : CommitId) (commit : RunCommit)
  | reserveObligation (run : RunId) (epoch : Nat) (obligation : OpenObligation)
  | completeObligation (run : RunId) (epoch : Nat) (obligation : OpenObligation)
  | recordAcceptanceVerdict (run : RunId) (verdict : AcceptanceVerdict)
  | beginTerminalization (run : RunId) (turn : TurnId) (receipt : ReceiptId)
  | forceCancelSibling (run : RunId) (terminalTurn sibling : TurnId)
  | terminalize (run : RunId) (turn : TurnId) (id expected : CommitId)
  deriving DecidableEq, Repr

def SiblingTurnsTerminalAndUnheld (store : GraphStore) (run : RunId)
    (terminalTurn : TurnId) : Prop :=
  ∀ id turn, store.turns id = some turn → turn.run = run → id ≠ terminalTurn →
    (turn.status = .succeeded ∨ turn.status = .failed ∨ turn.status = .cancelled) ∧
      turn.lease.holder = none

def CompleteAdmittedFrontier (store : GraphStore) (run : RunId)
    (epoch : Nat) (obligations : List OpenObligation) : Prop :=
  ∃ registry, store.admissionRegistry run = some registry ∧ registry.accepting = true ∧
    registry.epoch = epoch ∧ registry.outstanding = obligations

inductive GraphStep (effects : EffectLedger) (events : EventStore) (audit : AuditLog) :
    GraphStore → GraphLabel → GraphStore → Prop
  | startRun {store runId run rootId root cause} :
      store.runs runId = none → store.branches run.rootBranch = none → store.commits rootId = none →
      store.admissionRegistry runId = none →
      run.root = rootId → run.status = .active → run.pins.Valid run.agent →
      (run.acceptance.map AcceptanceCriterion.id).Nodup →
      (∀ criterion ∈ run.acceptance, ¬ store.DeclaresAcceptance criterion.id) →
      root.run = runId → root.branch = run.rootBranch →
      root.pins = run.pins → root.writer = .root cause → root.parents = [] → root.kind = .root →
      AuditCauseExists audit cause runId →
      GraphStep effects events audit store (.startRun runId rootId) {
        store with
        runs := tableSet store.runs runId run
        branches := tableSet store.branches run.rootBranch ⟨runId⟩
        commits := tableSet store.commits rootId root
        heads := tableSet store.heads run.rootBranch rootId
        admissionRegistry := tableSet store.admissionRegistry runId
          ⟨0, true, run.acceptance.map (fun criterion => .acceptance criterion.id), []⟩ }
  | startTurn {store id turn run branch} :
      store.turns id = none → store.runs turn.run = some run → run.status = .active →
      store.branches turn.branch = some branch → branch.run = turn.run →
      turn.pins.runPins = run.pins → turn.pins.placement.Valid →
      turn.status = .queued → turn.lease = TurnLease.initial id →
      GraphStep effects events audit store (.startTurn id)
        { store with turns := tableSet store.turns id turn }
  | claimTurn {store id turn holder now expires lease'} :
      store.turns id = some turn → turn.status = .queued →
      LeaseStep turn.lease (.claim holder now expires) lease' →
      GraphStep effects events audit store (.claimTurn id)
        { store with turns := tableSet store.turns id (turn.withStatusLease .running lease') }
  | suspendTurn {store id turn lease'} :
      store.turns id = some turn → turn.status = .running →
      LeaseStep turn.lease .suspendFence lease' →
      GraphStep effects events audit store (.suspendTurn id)
        { store with turns := tableSet store.turns id (turn.withStatusLease .suspended lease') }
  | resumeTurn {store id turn holder now expires lease'} :
      store.turns id = some turn → turn.status = .suspended → turn.lease.turn = id →
      LeaseStep turn.lease (.resume holder now expires) lease' →
      GraphStep effects events audit store (.resumeTurn id)
        { store with turns := tableSet store.turns id (turn.withStatusLease .running lease') }
  | spawnChild {store parentId childId rootId parent token now child root cause} :
      store.turns parentId = some parent → parent.status = .running → token.turn = parentId →
      parent.lease.Admits token now → store.runs childId = none →
      store.branches child.rootBranch = none → store.commits rootId = none →
      store.admissionRegistry childId = none →
      child.parent = some parent.run → child.root = rootId → child.status = .active →
      (child.acceptance.map AcceptanceCriterion.id).Nodup →
      (∀ criterion ∈ child.acceptance, ¬ store.DeclaresAcceptance criterion.id) →
      root.run = childId → root.branch = child.rootBranch → root.pins = child.pins →
      root.writer = .root cause → root.parents = [] → root.kind = .root →
      AuditCauseExists audit cause childId →
      GraphStep effects events audit store (.spawnChild parentId childId rootId) {
        store with
        runs := tableSet store.runs childId child
        branches := tableSet store.branches child.rootBranch ⟨childId⟩
        commits := tableSet store.commits rootId root
        heads := tableSet store.heads child.rootBranch rootId
        admissionRegistry := tableSet store.admissionRegistry childId
          ⟨0, true, child.acceptance.map (fun criterion => .acceptance criterion.id), []⟩ }
  | append {store id expected commit run branch now} :
      store.commits id = none → store.runs commit.run = some run → run.status = .active →
      store.branches commit.branch = some branch → branch.run = commit.run →
      store.heads commit.branch = some expected → ParentsClosed store commit →
      (match commit.kind with
       | .merge _ _ => CurrentMergeHeads store commit expected
       | .migration _ _ _ => False
       | .root => False
       | _ => commit.parents = [expected]) →
      CommitAllowed store effects events audit now commit →
      GraphStep effects events audit store (.append id expected commit) (store.append id commit)
  | migrate {store runId id expected commit run now} :
      store.runs runId = some run → run.status = .active → store.commits id = none →
      commit.run = runId →
      (∃ branch, store.branches commit.branch = some branch ∧ branch.run = runId) →
      store.heads commit.branch = some expected → commit.parents = [expected] →
      ParentsClosed store commit → CommitAllowed store effects events audit now commit →
      (∃ pins operation receipt,
        commit.kind = .migration pins operation receipt ∧ pins.Valid run.agent) →
      GraphStep effects events audit store (.migrate runId id expected commit)
        { (store.append id commit) with runs := tableSet store.runs runId { run with pins := commit.pins } }
  | reserveObligation {store runId run registry obligation} :
      store.runs runId = some run → run.status = .active →
      store.admissionRegistry runId = some registry → registry.accepting = true →
      obligation.NotAcceptance →
      obligation ∉ registry.reserved → obligation ∉ registry.completed →
      GraphStep effects events audit store (.reserveObligation runId registry.epoch obligation)
        (store.reserve runId registry obligation)
  | completeObligation {store runId run registry obligation} :
      store.runs runId = some run → run.status = .active →
      store.admissionRegistry runId = some registry → registry.accepting = true →
      obligation.NotAcceptance →
      obligation ∈ registry.reserved → obligation ∉ registry.completed →
      GraphStep effects events audit store (.completeObligation runId registry.epoch obligation)
        (store.complete runId registry obligation)
  | recordAcceptanceVerdict {store runId run criterion registry verdict outcome} :
      store.runs runId = some run → run.status = .active →
      criterion ∈ run.acceptance → criterion.id = verdict.acceptance →
      store.admissionRegistry runId = some registry → registry.accepting = true →
      OpenObligation.acceptance verdict.acceptance ∈ registry.reserved →
      OpenObligation.acceptance verdict.acceptance ∉ registry.completed →
      store.AcceptanceRetryAdmissible verdict.acceptance verdict.subject →
      VerifierReceipt effects verdict.receipt criterion.operation outcome →
      GraphStep effects events audit store (.recordAcceptanceVerdict runId verdict)
        (store.recordVerdict verdict)
  | beginTerminalization {store runId turnId receipt cause run turn} :
      store.runs runId = some run → run.status = .active → store.turns turnId = some turn →
      turn.run = runId → turn.status = .running → turn.pins.runPins = run.pins →
      store.terminalizing runId = none →
      TerminalizationControl.Valid effects audit runId ⟨turnId, receipt, cause⟩ →
      GraphStep effects events audit store (.beginTerminalization runId turnId receipt) {
        store with terminalizing := tableSet store.terminalizing runId ⟨turnId, receipt, cause⟩ }
  | forceCancelSibling {store runId terminalTurnId siblingId run terminalTurn sibling fenced
      evidence control cancellationAudit} :
      store.runs runId = some run → run.status = .active →
      store.terminalizing runId = some control → control.turn = terminalTurnId →
      terminalTurnId ≠ siblingId → store.turns terminalTurnId = some terminalTurn →
      terminalTurn.run = runId → terminalTurn.status = .running →
      store.turns siblingId = some sibling → sibling.run = runId →
      (sibling.status = .queued ∨ sibling.status = .running ∨ sibling.status = .suspended) →
      store.forcedCancellations siblingId = none →
      AuditCauseExists audit control.audit runId → AuditCauseExists audit cancellationAudit runId →
      LeaseStep sibling.lease .terminalFence fenced →
      evidence = ⟨runId, terminalTurnId, siblingId, sibling.lease.epoch, fenced.epoch,
        control.receipt, control.audit, cancellationAudit⟩ →
      GraphStep effects events audit store (.forceCancelSibling runId terminalTurnId siblingId) {
        store with
        turns := tableSet store.turns siblingId (sibling.withStatusLease .cancelled fenced)
        forcedCancellations := tableSet store.forcedCancellations siblingId evidence }
  | terminalize {store runId turnId id expected run turn token now fenced terminal registry commit
      preterminal snapshot cause control} :
      store.runs runId = some run → run.status = .active → store.turns turnId = some turn →
      turn.run = runId → turn.status = .running → token.turn = turnId → turn.lease.Admits token now →
      run.pins.Valid run.agent → turn.pins.runPins = run.pins →
      store.terminalizing runId = some control → control.turn = turnId →
      SiblingTurnsTerminalAndUnheld store runId turnId → LeaseStep turn.lease .terminalFence fenced →
      (terminal = .succeeded ∨ terminal = .failed ∨ terminal = .cancelled) →
      store.heads turn.branch = some expected → store.commits expected = some preterminal →
      preterminal.run = runId → preterminal.pins = run.pins → store.commits id = none →
      store.admissionRegistry runId = some registry → registry.accepting = true →
      commit.run = runId → commit.branch = turn.branch → commit.pins = run.pins →
      commit.writer = .turn token cause → AuditCauseExists audit cause runId →
      commit.parents = [expected] →
      commit.subjectTurn = some turnId →
      commit.kind = .terminal (match terminal with
        | .succeeded => .succeeded | .failed => .failed | .cancelled => .cancelled | _ => .failed) →
      snapshot = ⟨runId, turnId, expected, id,
        (match terminal with
         | .succeeded => .succeeded | .failed => .failed | .cancelled => .cancelled | _ => .failed),
          registry.epoch, registry.outstanding⟩ →
      GraphStep effects events audit store (.terminalize runId turnId id expected) {
        (store.append id commit) with
        runs := tableSet store.runs runId { run with status := .terminal }
        turns := tableSet store.turns turnId (turn.withStatusLease terminal fenced)
        terminalSnapshots := tableSet store.terminalSnapshots runId snapshot
        admissionRegistry := tableSet store.admissionRegistry runId registry.close
        terminalizing := fun candidate => if candidate = runId then none else store.terminalizing candidate }

theorem unary_commit_inherits_pins {store effects events audit now commit}
    (allowed : CommitAllowed store effects events audit now commit)
    (unary : commit.kind = .message ∨ commit.kind = .checkpoint ∨
      ∃ outcome, commit.kind = .terminal outcome) : UnaryPinsInherited store commit := by
  rcases unary with message | checkpoint | ⟨outcome, terminal⟩
  · cases writerEq : commit.writer with
    | root cause => simp [CommitAllowed, message, writerEq] at allowed
    | system cause => simp [CommitAllowed, message, writerEq] at allowed
    | turn token cause =>
        unfold CommitAllowed at allowed
        rw [message, writerEq] at allowed
        exact allowed.1
  · cases writerEq : commit.writer with
    | root cause => simp [CommitAllowed, checkpoint, writerEq] at allowed
    | system cause => simp [CommitAllowed, checkpoint, writerEq] at allowed
    | turn token cause =>
        unfold CommitAllowed at allowed
        rw [checkpoint, writerEq] at allowed
        exact allowed.1
  · cases writerEq : commit.writer with
    | root cause => simp [CommitAllowed, terminal, writerEq] at allowed
    | system cause => simp [CommitAllowed, terminal, writerEq] at allowed
    | turn token cause =>
        unfold CommitAllowed at allowed
        rw [terminal, writerEq] at allowed
        exact allowed.1

theorem merge_has_equal_pinned_current_heads {store : GraphStore} {commit expected}
    (heads : CurrentMergeHeads store commit expected) :
    ∃ (sourceBranch : BranchId) (sourceHead : CommitId) (destination source : RunCommit),
      store.heads commit.branch = some expected ∧ store.heads sourceBranch = some sourceHead ∧
      commit.parents = [expected, sourceHead] ∧ expected ≠ sourceHead ∧
      destination.pins = commit.pins ∧ source.pins = commit.pins := by
  obtain ⟨sourceBranch, sourceHead, destination, source, different, destinationHead, sourceHeadEq,
    unique, parents, destinationLookup, sourceLookup, destinationRun, sourceRun,
    destinationPins, sourcePins⟩ := heads
  exact ⟨sourceBranch, sourceHead, destination, source, destinationHead, sourceHeadEq,
    parents, unique, destinationPins, sourcePins⟩

theorem environment_pin_identity_prevents_revision_alias {left right : RunPins}
    (different : left.environment.id ≠ right.environment.id)
    (sameRevision : left.environment.revision = right.environment.revision) :
    left ≠ right ∧ left.environment.revision = right.environment.revision := by
  refine ⟨?_, sameRevision⟩
  intro equalPins
  apply different
  rw [equalPins]

def TerminalSnapshotCoherent (store : GraphStore) (snapshot : TerminalSnapshot) : Prop :=
  ∃ run turn terminal,
    store.runs snapshot.run = some run ∧ run.status = .terminal ∧
    store.turns snapshot.turn = some turn ∧ turn.run = snapshot.run ∧
    store.commits snapshot.terminalCommit = some terminal ∧
    terminal.run = snapshot.run ∧ terminal.subjectTurn = some snapshot.turn ∧
    terminal.parents = [snapshot.preterminal] ∧ terminal.kind = .terminal snapshot.outcome

theorem terminal_snapshot_is_coherent {effects events audit before after run turn id expected}
    (step : GraphStep effects events audit before (.terminalize run turn id expected) after) :
    ∃ snapshot, after.terminalSnapshots run = some snapshot ∧
      TerminalSnapshotCoherent after snapshot := by
  cases step <;>
    simp_all [TerminalSnapshotCoherent, GraphStore.append, Turn.withStatusLease, tableSet_self]

theorem terminal_snapshot_captures_complete_frontier
    {effects events audit before after run turn id expected}
    (step : GraphStep effects events audit before (.terminalize run turn id expected) after) :
    ∃ snapshot, after.terminalSnapshots run = some snapshot ∧
      CompleteAdmittedFrontier before run snapshot.registryEpoch snapshot.obligations := by
  cases step <;> simp_all [CompleteAdmittedFrontier, tableSet_self]

theorem forced_cancellation_is_system_fence
    {effects events audit before after run terminalTurn sibling}
    (step : GraphStep effects events audit before
      (.forceCancelSibling run terminalTurn sibling) after) :
    ∃ prior cancelled evidence,
      before.turns sibling = some prior ∧ after.turns sibling = some cancelled ∧
      cancelled.status = .cancelled ∧ cancelled.lease.holder = none ∧
      after.forcedCancellations sibling = some evidence ∧
      evidence.run = run ∧ evidence.terminalTurn = terminalTurn ∧
      evidence.turn = sibling ∧
      evidence.priorLeaseEpoch = prior.lease.epoch ∧
      evidence.fencedLeaseEpoch = prior.lease.epoch + 1 := by
  cases step with
  | forceCancelSibling runLookup active controlLookup controlTurn distinct terminalLookup terminalRun
      terminalRunning siblingLookup siblingRun live fresh controlAudit cancellationAudit fence evidenceEq =>
      rename_i runRecord terminalRecord siblingRecord fencedRecord evidenceRecord controlRecord
        cancellationAuditRecord
      subst_vars
      cases fence
      simp [Turn.withStatusLease, tableSet_self]
      exact ⟨siblingRecord, siblingLookup, rfl⟩

theorem spawn_child_requires_fresh_branch_and_root {effects events audit before after parent child root}
    (step : GraphStep effects events audit before (.spawnChild parent child root) after) :
    ∃ childRecord : Run, before.branches childRecord.rootBranch = none ∧
      before.commits root = none := by
  cases step with
  | spawnChild parentLookup running exactTurn admits runFresh branchFresh rootFresh parentRun childRoot
      active rootRun rootBranch rootPins writer parents kind cause =>
      exact ⟨_, branchFresh, rootFresh⟩

theorem migration_requires_fresh_commit_on_owned_branch {effects events audit before after run id expected commit}
    (step : GraphStep effects events audit before (.migrate run id expected commit) after) :
    before.commits id = none ∧
      ∃ branch, before.branches commit.branch = some branch ∧ branch.run = run := by
  cases step with
  | migrate runLookup active fresh commitRun branch head parents closed allowed kind =>
      exact ⟨fresh, branch⟩

theorem migration_requires_valid_target_pins
    {effects events audit before after run id expected commit}
    (step : GraphStep effects events audit before (.migrate run id expected commit) after) :
    ∃ runRecord pins operation receipt,
      before.runs run = some runRecord ∧ commit.kind = .migration pins operation receipt ∧
      pins.Valid runRecord.agent := by
  cases step
  simp_all

theorem spawn_child_rejects_existing_root {effects events audit before after parent child root record}
    (existing : before.commits root = some record) :
    ¬ GraphStep effects events audit before (.spawnChild parent child root) after := by
  intro step
  obtain ⟨childRecord, branchFresh, rootFresh⟩ := spawn_child_requires_fresh_branch_and_root step
  rw [existing] at rootFresh
  contradiction

theorem migration_rejects_existing_commit {effects events audit before after run id expected commit record}
    (existing : before.commits id = some record) :
    ¬ GraphStep effects events audit before (.migrate run id expected commit) after := by
  intro step
  obtain ⟨fresh, branch⟩ := migration_requires_fresh_commit_on_owned_branch step
  rw [existing] at fresh
  contradiction

theorem terminalization_requires_terminal_and_unheld_siblings
    {effects events audit before after run turn id expected}
    (step : GraphStep effects events audit before (.terminalize run turn id expected) after) :
    SiblingTurnsTerminalAndUnheld before run turn := by
  cases step
  assumption

theorem terminalization_requires_current_turn_pins
    {effects events audit before after run turn id expected}
    (step : GraphStep effects events audit before (.terminalize run turn id expected) after) :
    ∃ runRecord turnRecord,
      before.runs run = some runRecord ∧ before.turns turn = some turnRecord ∧
      runRecord.pins.Valid runRecord.agent ∧ turnRecord.pins.runPins = runRecord.pins := by
  cases step <;> simp_all

theorem migrated_old_turn_cannot_terminalize
    {effects events audit before after run turn id expected runRecord turnRecord}
    (runLookup : before.runs run = some runRecord)
    (turnLookup : before.turns turn = some turnRecord)
    (stalePins : turnRecord.pins.runPins ≠ runRecord.pins) :
    ¬ GraphStep effects events audit before (.terminalize run turn id expected) after := by
  intro step
  obtain ⟨actualRun, actualTurn, runFound, turnFound, valid, exactPins⟩ :=
    terminalization_requires_current_turn_pins step
  rw [runLookup] at runFound
  rw [turnLookup] at turnFound
  cases Option.some.inj runFound
  cases Option.some.inj turnFound
  exact stalePins exactPins

theorem reserved_obligation_is_in_registry
    {effects events audit before after run epoch obligation}
    (step : GraphStep effects events audit before (.reserveObligation run epoch obligation) after) :
    ∃ registry, after.admissionRegistry run = some registry ∧
      registry.epoch = epoch ∧ obligation ∈ registry.reserved := by
  cases step
  refine ⟨_, tableSet_self .., rfl, ?_⟩
  simp [RunAdmissionRegistry.reserve]

theorem reserved_obligation_yields_valid_reservation
    {effects events audit before after run epoch obligation}
    (step : GraphStep effects events audit before (.reserveObligation run epoch obligation) after) :
    (⟨run, epoch, obligation⟩ : AdmissionReservation).ValidIn after := by
  cases step
  simp_all [AdmissionReservation.ValidIn, GraphStore.reserve, RunAdmissionRegistry.reserve,
    tableSet_self]

theorem completed_obligation_is_reserved
    {effects events audit before after run epoch obligation}
    (step : GraphStep effects events audit before (.completeObligation run epoch obligation) after) :
    ∃ beforeRegistry afterRegistry,
      before.admissionRegistry run = some beforeRegistry ∧
      after.admissionRegistry run = some afterRegistry ∧
      obligation ∈ beforeRegistry.reserved ∧ obligation ∈ afterRegistry.completed := by
  cases step
  refine ⟨_, _, ‹_›, tableSet_self .., ‹_›, ?_⟩
  simp [RunAdmissionRegistry.complete]

theorem terminalization_closes_exact_registry
    {effects events audit before after run turn id expected}
    (step : GraphStep effects events audit before (.terminalize run turn id expected) after) :
    ∃ beforeRegistry afterRegistry snapshot,
      before.admissionRegistry run = some beforeRegistry ∧
      after.admissionRegistry run = some afterRegistry ∧
      afterRegistry.accepting = false ∧ afterRegistry.epoch = beforeRegistry.epoch + 1 ∧
      after.terminalSnapshots run = some snapshot ∧
      snapshot.registryEpoch = beforeRegistry.epoch ∧
      snapshot.obligations = beforeRegistry.outstanding := by
  cases step
  simp_all [RunAdmissionRegistry.close, tableSet_self]

theorem terminal_snapshot_has_no_omission_or_extra
    {effects events audit before after run turn id expected}
    (step : GraphStep effects events audit before (.terminalize run turn id expected) after) :
    ∃ registry snapshot,
      before.admissionRegistry run = some registry ∧
      after.terminalSnapshots run = some snapshot ∧
      ∀ obligation, obligation ∈ snapshot.obligations ↔
        obligation ∈ registry.reserved ∧ obligation ∉ registry.completed := by
  cases step
  refine ⟨_, _, ‹_›, tableSet_self .., ?_⟩
  intro obligation
  simp_all [RunAdmissionRegistry.outstanding]
/-! ## Acceptance obligations over the transition system

An acceptance criterion enters the admission registry when its Run opens and never leaves it.
§5.2: the obligation is not completed as bookkeeping when the verdict arrives -- that would
freeze it against whatever tree was current at that instant, and a later commit carrying a new
tree checkpoint would leave the Run settling on a proof about a tree it no longer has. It stays
outstanding for the Run's whole life, is snapshotted at terminalization like any other
obligation, and is discharged only by evaluation at settlement against the head the Run
actually finished on. The generic reserve and complete paths refuse acceptance outright, and
completion is the only thing any transition ever writes to a completed list, so no reachable
graph has a declared criterion out of the frontier. -/

theorem generic_reservation_refuses_acceptance
    {effects events audit before after run epoch accId} :
    ¬ GraphStep effects events audit before
      (.reserveObligation run epoch (.acceptance accId)) after := by
  intro step
  cases step
  simp [OpenObligation.NotAcceptance] at *

theorem generic_completion_refuses_acceptance
    {effects events audit before after run epoch accId} :
    ¬ GraphStep effects events audit before
      (.completeObligation run epoch (.acceptance accId)) after := by
  intro step
  cases step
  simp [OpenObligation.NotAcceptance] at *

theorem run_start_reserves_exactly_declared_acceptance
    {effects events audit before after run root}
    (step : GraphStep effects events audit before (.startRun run root) after) :
    ∃ record registry, after.runs run = some record ∧
      after.admissionRegistry run = some registry ∧ registry.completed = [] ∧
      (record.acceptance.map AcceptanceCriterion.id).Nodup ∧
      (∀ criterion ∈ record.acceptance, ¬ before.DeclaresAcceptance criterion.id) ∧
      ∀ obligation, obligation ∈ registry.reserved ↔
        ∃ criterion ∈ record.acceptance, OpenObligation.acceptance criterion.id = obligation := by
  cases step
  refine ⟨_, _, tableSet_self .., tableSet_self .., rfl, ‹_›, ‹_›, ?_⟩
  intro obligation
  simp [List.mem_map]

theorem spawn_child_reserves_exactly_declared_acceptance
    {effects events audit before after parent child root}
    (step : GraphStep effects events audit before (.spawnChild parent child root) after) :
    ∃ record registry, after.runs child = some record ∧
      after.admissionRegistry child = some registry ∧ registry.completed = [] ∧
      (record.acceptance.map AcceptanceCriterion.id).Nodup ∧
      (∀ criterion ∈ record.acceptance, ¬ before.DeclaresAcceptance criterion.id) ∧
      ∀ obligation, obligation ∈ registry.reserved ↔
        ∃ criterion ∈ record.acceptance, OpenObligation.acceptance criterion.id = obligation := by
  cases step
  refine ⟨_, _, tableSet_self .., tableSet_self .., rfl, ‹_›, ‹_›, ?_⟩
  intro obligation
  simp [List.mem_map]

theorem acceptance_verdict_step_requires_declared_verifier_receipt
    {effects events audit before after run verdict}
    (step : GraphStep effects events audit before (.recordAcceptanceVerdict run verdict) after) :
    ∃ record criterion outcome, before.runs run = some record ∧
      criterion ∈ record.acceptance ∧ criterion.id = verdict.acceptance ∧
      VerifierReceipt effects verdict.receipt criterion.operation outcome ∧
      before.AcceptanceRetryAdmissible verdict.acceptance verdict.subject ∧
      verdict ∈ after.acceptanceVerdicts verdict.acceptance := by
  cases step
  refine ⟨_, _, _, ‹_›, ‹_›, ‹_›, ‹_›, ‹_›, ?_⟩
  simp [GraphStore.recordVerdict]

/-- While a criterion holds a verdict naming a subject, a further attempt against that same
    subject is inadmissible: the system MUST NOT run the verifier again against inputs it has
    not moved (§5.2, C13-RUN-ACCEPTANCE-SUBJECT). -/
theorem acceptance_current_verdict_blocks_retry {store : GraphStore} {accId subject verdict}
    (verdictMem : verdict ∈ store.acceptanceVerdicts accId)
    (vAcc : verdict.acceptance = accId)
    (vSubj : verdict.subject = subject) :
    ¬ store.AcceptanceRetryAdmissible accId subject := by
  intro admissible
  exact admissible verdict verdictMem vAcc vSubj

/-- A subject that already holds a verdict for the criterion admits no further verifier
    attempt: the recording transition itself is unavailable, not merely inadvisable. -/
theorem recorded_verdict_blocks_repeat_verdict_step
    {effects events audit before after run verdict recorded}
    (recordedMem : recorded ∈ before.acceptanceVerdicts verdict.acceptance)
    (sameCriterion : recorded.acceptance = verdict.acceptance)
    (sameSubject : recorded.subject = verdict.subject) :
    ¬ GraphStep effects events audit before (.recordAcceptanceVerdict run verdict) after := by
  intro step
  obtain ⟨_, _, _, _, _, _, _, admissible, _⟩ :=
    acceptance_verdict_step_requires_declared_verifier_receipt step
  exact acceptance_current_verdict_blocks_retry recordedMem sameCriterion sameSubject admissible

/-- A Run has at most one current head tree, so "the subject the verdict names" and "the tree
    the Run is at" cannot both be satisfied by two different digests. -/
theorem head_tree_is_unique {store : GraphStore} {run left right}
    (leftHead : store.HeadTree run left) (rightHead : store.HeadTree run right) : left = right := by
  obtain ⟨record, head, commit, runLookup, headLookup, commitLookup, _, checkpoint⟩ := leftHead
  obtain ⟨_, _, _, runLookup', headLookup', commitLookup', _, checkpoint'⟩ := rightHead
  rw [runLookup] at runLookup'
  cases Option.some.inj runLookup'
  rw [headLookup] at headLookup'
  cases Option.some.inj headLookup'
  rw [commitLookup] at commitLookup'
  cases Option.some.inj commitLookup'
  rw [checkpoint] at checkpoint'
  exact Option.some.inj checkpoint'

/-- A verdict is evidence for its exact subject and nothing else: if no recorded verdict names
    the Run's current head tree, the criterion is unsatisfied, whatever other subjects earlier
    verdicts named (§5.2, C13-RUN-ACCEPTANCE-SUBJECT). -/
theorem acceptance_verdict_only_for_its_subject {store effects run accId subject}
    (headLookup : store.HeadTree run subject)
    (noVerdictAtHead : ∀ verdict ∈ store.acceptanceVerdicts accId,
      verdict.acceptance = accId → verdict.subject ≠ subject) :
    ¬ AcceptanceSatisfied store effects run accId := by
  intro satisfied
  obtain ⟨subject', verdict, _, headLookup', verdictMem, vAcc, vSubj, _⟩ := satisfied
  exact noVerdictAtHead verdict verdictMem vAcc
    (by rw [vSubj]; exact head_tree_is_unique headLookup' headLookup)

/-- Every acceptance criterion a Run declared is reserved in that Run's admission registry and
    is never recorded completed, so it is still in the outstanding frontier that terminalization
    snapshots and that settlement evaluates. -/
def AcceptanceObligationsOutstanding (store : GraphStore) : Prop :=
  ∀ runId criterion, criterion ∈ store.acceptanceCriteria runId →
    ∃ registry, store.admissionRegistry runId = some registry ∧
      OpenObligation.acceptance criterion.id ∈ registry.reserved ∧
      OpenObligation.acceptance criterion.id ∉ registry.completed

/-- An `AcceptanceId` identifies one criterion across the whole store, so "the criterion this
    obligation names" is well defined even though the obligation carries only the identity. -/
def AcceptanceCriteriaUnique (store : GraphStore) : Prop :=
  ∀ leftRun rightRun left right, left ∈ store.acceptanceCriteria leftRun →
    right ∈ store.acceptanceCriteria rightRun → left.id = right.id → left = right

/-- Every verdict on the record was earned: it is filed under a criterion some Run declared,
    and it names an attempted Receipt of that criterion's own declared verifier Operation.
    Settlement never re-reads the Operation, so this is what stops a succeeded Receipt from
    anywhere at all from counting as this criterion's evidence (§5.2). -/
def AcceptanceVerdictsEarned (store : GraphStore) (effects : EffectLedger) : Prop :=
  ∀ accId verdict, verdict ∈ store.acceptanceVerdicts accId →
    ∃ runId criterion outcome,
      criterion ∈ store.acceptanceCriteria runId ∧ criterion.id = accId ∧
      VerifierReceipt effects verdict.receipt criterion.operation outcome

/-- A recorded terminal snapshot keeps agreeing with its Run's closed registry: the captured
    frontier stays exactly reserved minus completed, because closing the registry is what
    makes further reservation and completion unavailable. -/
def TerminalSnapshotsMatchRegistry (store : GraphStore) : Prop :=
  ∀ runId snapshot, store.terminalSnapshots runId = some snapshot →
    ∃ registry, store.admissionRegistry runId = some registry ∧ registry.accepting = false ∧
      ∀ obligation, obligation ∈ snapshot.obligations ↔
        (obligation ∈ registry.reserved ∧ obligation ∉ registry.completed)

/-- What a transition may do to the admission registries: a Run that has one keeps one, its
    reservations only grow, and no acceptance obligation newly appears completed. -/
def RegistriesAdvance (before after : GraphStore) : Prop :=
  ∀ runId prior, before.admissionRegistry runId = some prior →
    ∃ next, after.admissionRegistry runId = some next ∧ prior.reserved ⊆ next.reserved ∧
      ∀ accId, OpenObligation.acceptance accId ∈ next.completed →
        OpenObligation.acceptance accId ∈ prior.completed

private theorem registries_of_registry_update {before after : GraphStore}
    {runId : RunId} {registry updated : RunAdmissionRegistry}
    (registryLookup : before.admissionRegistry runId = some registry)
    (registries : after.admissionRegistry = tableSet before.admissionRegistry runId updated)
    (grows : registry.reserved ⊆ updated.reserved)
    (closed : ∀ accId, OpenObligation.acceptance accId ∈ updated.completed →
      OpenObligation.acceptance accId ∈ registry.completed) :
    RegistriesAdvance before after := by
  intro id prior priorLookup
  by_cases same : id = runId
  · subst same
    rw [registryLookup] at priorLookup
    cases Option.some.inj priorLookup
    exact ⟨updated, by rw [registries]; exact tableSet_self .., grows, closed⟩
  · exact ⟨prior, by rw [registries, tableSet_other _ _ _ same]; exact priorLookup,
      List.Subset.refl _, fun _ member => member⟩

private theorem registries_of_fresh_registry {before after : GraphStore}
    {runId : RunId} {opened : RunAdmissionRegistry}
    (registryFresh : before.admissionRegistry runId = none)
    (registries : after.admissionRegistry = tableSet before.admissionRegistry runId opened) :
    RegistriesAdvance before after := by
  intro id prior priorLookup
  by_cases same : id = runId
  · subst same
    rw [registryFresh] at priorLookup
    contradiction
  · exact ⟨prior, by rw [registries, tableSet_other _ _ _ same]; exact priorLookup,
      List.Subset.refl _, fun _ member => member⟩

private theorem completed_stays_acceptance_free {registry : RunAdmissionRegistry}
    {obligation : OpenObligation} (notAcceptance : obligation.NotAcceptance) :
    ∀ accId, OpenObligation.acceptance accId ∈ (registry.complete obligation).completed →
      OpenObligation.acceptance accId ∈ registry.completed := by
  intro accId member
  simp only [RunAdmissionRegistry.complete, List.mem_append, List.mem_singleton] at member
  rcases member with inside | isObligation
  · exact inside
  · rw [← isObligation] at notAcceptance
    simp [OpenObligation.NotAcceptance] at notAcceptance

/-- No transition ever retires an acceptance obligation. Generic completion is the only step
    that writes a completed list at all and it refuses acceptance, so a declared criterion stays
    outstanding for the Run's whole life -- which is what makes settlement evaluate it against
    the current head instead of a frozen one (§5.2). -/
theorem graph_step_advances_registries {effects events audit before after label}
    (step : GraphStep effects events audit before label after) :
    RegistriesAdvance before after := by
  cases step with
  | startTurn | claimTurn | suspendTurn | resumeTurn | append | migrate
  | recordAcceptanceVerdict | beginTerminalization | forceCancelSibling =>
      exact fun _ prior lookup => ⟨prior, lookup, List.Subset.refl _, fun _ member => member⟩
  | startRun runFresh branchFresh commitFresh registryFresh rootEq active valid nodup fresh
      rootRun rootBranch rootPins writer parents kind cause =>
      exact registries_of_fresh_registry registryFresh rfl
  | spawnChild parentLookup running exactTurn admits runFresh branchFresh commitFresh
      registryFresh childParent childRoot active nodup fresh rootRun rootBranch rootPins writer
      parents kind cause =>
      exact registries_of_fresh_registry registryFresh rfl
  | reserveObligation runLookup active registryLookup accepting notAcceptance notReserved
      notCompleted =>
      exact registries_of_registry_update registryLookup rfl
        (by simp [RunAdmissionRegistry.reserve]) (fun _ member => member)
  | completeObligation runLookup active registryLookup accepting notAcceptance reserved
      notCompleted =>
      exact registries_of_registry_update registryLookup rfl (List.Subset.refl _)
        (completed_stays_acceptance_free notAcceptance)
  | terminalize runLookup active turnLookup turnRun running exactTurn admits validPins turnPins
      controlLookup controlTurn siblings fence outcome headLookup preterminalLookup
      preterminalRun preterminalPins commitFresh registryLookup accepting commitRun commitBranch
      commitPins writer cause parents subjectTurn kindEq snapshotEq =>
      exact registries_of_registry_update registryLookup rfl (List.Subset.refl _)
        (fun _ member => member)

private theorem criteria_stable_of_run_update {before after : GraphStore}
    {runId : RunId} {prior updated : Run}
    (runLookup : before.runs runId = some prior)
    (runs : after.runs = tableSet before.runs runId updated)
    (sameAcceptance : updated.acceptance = prior.acceptance) :
    ∀ id, after.acceptanceCriteria id = before.acceptanceCriteria id := by
  intro id
  by_cases same : id = runId
  · subst same
    simp [GraphStore.acceptanceCriteria, runs, tableSet_self, runLookup, sameAcceptance]
  · simp [GraphStore.acceptanceCriteria, runs, tableSet_other _ _ _ same]

private theorem criteria_of_run_open {before after : GraphStore} {runId : RunId} {opened : Run}
    (runs : after.runs = tableSet before.runs runId opened) :
    after.acceptanceCriteria runId = opened.acceptance ∧
      ∀ id, id ≠ runId → after.acceptanceCriteria id = before.acceptanceCriteria id := by
  refine ⟨by simp [GraphStore.acceptanceCriteria, runs, tableSet_self], fun id different => ?_⟩
  simp [GraphStore.acceptanceCriteria, runs, tableSet_other _ _ _ different]

private theorem outstanding_of_stable_criteria {before after : GraphStore}
    (outstanding : AcceptanceObligationsOutstanding before)
    (advance : RegistriesAdvance before after)
    (criteria : ∀ id, after.acceptanceCriteria id = before.acceptanceCriteria id) :
    AcceptanceObligationsOutstanding after := by
  intro runId criterion declared
  rw [criteria] at declared
  obtain ⟨registry, registryLookup, reserved, notCompleted⟩ := outstanding runId criterion declared
  obtain ⟨next, nextLookup, grows, closed⟩ := advance runId registry registryLookup
  exact ⟨next, nextLookup, grows reserved, fun member => notCompleted (closed _ member)⟩

private theorem outstanding_of_run_open {before after : GraphStore}
    {runId : RunId} {opened : Run}
    (outstanding : AcceptanceObligationsOutstanding before)
    (advance : RegistriesAdvance before after)
    (runs : after.runs = tableSet before.runs runId opened)
    (registries : after.admissionRegistry = tableSet before.admissionRegistry runId
      ⟨0, true, opened.acceptance.map (fun criterion => .acceptance criterion.id), []⟩) :
    AcceptanceObligationsOutstanding after := by
  obtain ⟨openedCriteria, otherCriteria⟩ := criteria_of_run_open runs
  intro candidate criterion declared
  by_cases same : candidate = runId
  · rw [same] at declared ⊢
    rw [openedCriteria] at declared
    exact ⟨_, by rw [registries]; exact tableSet_self .., List.mem_map_of_mem declared, by simp⟩
  · rw [otherCriteria candidate same] at declared
    obtain ⟨registry, registryLookup, reserved, notCompleted⟩ :=
      outstanding candidate criterion declared
    obtain ⟨next, nextLookup, grows, closed⟩ := advance candidate registry registryLookup
    exact ⟨next, nextLookup, grows reserved, fun member => notCompleted (closed _ member)⟩

theorem graph_step_preserves_acceptance_outstanding {effects events audit before after label}
    (outstanding : AcceptanceObligationsOutstanding before)
    (step : GraphStep effects events audit before label after) :
    AcceptanceObligationsOutstanding after := by
  have advance : RegistriesAdvance before after := graph_step_advances_registries step
  cases step with
  | startTurn | claimTurn | suspendTurn | resumeTurn | append | reserveObligation
  | completeObligation | recordAcceptanceVerdict | beginTerminalization | forceCancelSibling =>
      exact outstanding_of_stable_criteria outstanding advance (fun _ => rfl)
  | startRun runFresh branchFresh commitFresh registryFresh rootEq active valid nodup fresh
      rootRun rootBranch rootPins writer parents kind cause =>
      exact outstanding_of_run_open outstanding advance rfl rfl
  | spawnChild parentLookup running exactTurn admits runFresh branchFresh commitFresh
      registryFresh childParent childRoot active nodup fresh rootRun rootBranch rootPins writer
      parents kind cause =>
      exact outstanding_of_run_open outstanding advance rfl rfl
  | migrate runLookup active commitFresh commitRun branchOwned headLookup parents closed allowed
      kindValid =>
      exact outstanding_of_stable_criteria outstanding advance
        (criteria_stable_of_run_update runLookup rfl rfl)
  | terminalize runLookup active turnLookup turnRun running exactTurn admits validPins turnPins
      controlLookup controlTurn siblings fence outcome headLookup preterminalLookup
      preterminalRun preterminalPins commitFresh registryLookup accepting commitRun commitBranch
      commitPins writer cause parents subjectTurn kindEq snapshotEq =>
      exact outstanding_of_stable_criteria outstanding advance
        (criteria_stable_of_run_update runLookup rfl rfl)

private theorem criterion_eq_of_nodup {criteria : List AcceptanceCriterion}
    (nodup : (criteria.map AcceptanceCriterion.id).Nodup)
    {left right : AcceptanceCriterion} (leftMem : left ∈ criteria) (rightMem : right ∈ criteria)
    (sameId : left.id = right.id) : left = right := by
  induction criteria with
  | nil => cases leftMem
  | cons head tail ih =>
      rw [List.map_cons, List.nodup_cons] at nodup
      rcases List.mem_cons.mp leftMem with leftHead | leftTail
      · rcases List.mem_cons.mp rightMem with rightHead | rightTail
        · rw [leftHead, rightHead]
        · have member : right.id ∈ tail.map AcceptanceCriterion.id :=
            List.mem_map_of_mem rightTail
          rw [← sameId, leftHead] at member
          exact absurd member nodup.1
      · rcases List.mem_cons.mp rightMem with rightHead | rightTail
        · have member : left.id ∈ tail.map AcceptanceCriterion.id :=
            List.mem_map_of_mem leftTail
          rw [sameId, rightHead] at member
          exact absurd member nodup.1
        · exact ih nodup.2 leftTail rightTail

private theorem unique_of_stable_criteria {before after : GraphStore}
    (unique : AcceptanceCriteriaUnique before)
    (criteria : ∀ id, after.acceptanceCriteria id = before.acceptanceCriteria id) :
    AcceptanceCriteriaUnique after := by
  intro leftRun rightRun left right leftMem rightMem sameId
  rw [criteria] at leftMem rightMem
  exact unique leftRun rightRun left right leftMem rightMem sameId

private theorem unique_of_run_open {before after : GraphStore} {runId : RunId} {opened : Run}
    (unique : AcceptanceCriteriaUnique before)
    (nodup : (opened.acceptance.map AcceptanceCriterion.id).Nodup)
    (fresh : ∀ criterion ∈ opened.acceptance, ¬ before.DeclaresAcceptance criterion.id)
    (runs : after.runs = tableSet before.runs runId opened) :
    AcceptanceCriteriaUnique after := by
  obtain ⟨openedCriteria, otherCriteria⟩ := criteria_of_run_open runs
  intro leftRun rightRun left right leftMem rightMem sameId
  by_cases leftSame : leftRun = runId
  · rw [leftSame, openedCriteria] at leftMem
    by_cases rightSame : rightRun = runId
    · rw [rightSame, openedCriteria] at rightMem
      exact criterion_eq_of_nodup nodup leftMem rightMem sameId
    · rw [otherCriteria rightRun rightSame] at rightMem
      exact absurd ⟨rightRun, right, rightMem, sameId.symm⟩ (fresh left leftMem)
  · rw [otherCriteria leftRun leftSame] at leftMem
    by_cases rightSame : rightRun = runId
    · rw [rightSame, openedCriteria] at rightMem
      exact absurd ⟨leftRun, left, leftMem, sameId⟩ (fresh right rightMem)
    · rw [otherCriteria rightRun rightSame] at rightMem
      exact unique leftRun rightRun left right leftMem rightMem sameId

theorem graph_step_preserves_acceptance_criteria_unique {effects events audit before after label}
    (unique : AcceptanceCriteriaUnique before)
    (step : GraphStep effects events audit before label after) :
    AcceptanceCriteriaUnique after := by
  cases step with
  | startTurn | claimTurn | suspendTurn | resumeTurn | append | reserveObligation
  | completeObligation | recordAcceptanceVerdict | beginTerminalization | forceCancelSibling =>
      exact unique_of_stable_criteria unique (fun _ => rfl)
  | startRun runFresh branchFresh commitFresh registryFresh rootEq active valid nodup fresh
      rootRun rootBranch rootPins writer parents kind cause =>
      exact unique_of_run_open unique nodup fresh rfl
  | spawnChild parentLookup running exactTurn admits runFresh branchFresh commitFresh
      registryFresh childParent childRoot active nodup fresh rootRun rootBranch rootPins writer
      parents kind cause =>
      exact unique_of_run_open unique nodup fresh rfl
  | migrate runLookup active commitFresh commitRun branchOwned headLookup parents closed allowed
      kindValid =>
      exact unique_of_stable_criteria unique (criteria_stable_of_run_update runLookup rfl rfl)
  | terminalize runLookup active turnLookup turnRun running exactTurn admits validPins turnPins
      controlLookup controlTurn siblings fence outcome headLookup preterminalLookup
      preterminalRun preterminalPins commitFresh registryLookup accepting commitRun commitBranch
      commitPins writer cause parents subjectTurn kindEq snapshotEq =>
      exact unique_of_stable_criteria unique (criteria_stable_of_run_update runLookup rfl rfl)

theorem record_verdict_at_criterion {store : GraphStore} {verdict : AcceptanceVerdict} :
    (store.recordVerdict verdict).acceptanceVerdicts verdict.acceptance =
      verdict :: store.acceptanceVerdicts verdict.acceptance := by
  simp [GraphStore.recordVerdict]

theorem record_verdict_elsewhere {store : GraphStore} {verdict : AcceptanceVerdict}
    {id : AcceptanceId} (different : id ≠ verdict.acceptance) :
    (store.recordVerdict verdict).acceptanceVerdicts id = store.acceptanceVerdicts id := by
  simp [GraphStore.recordVerdict, different]

private theorem earned_of_extension {before after : GraphStore} {effects}
    (earned : AcceptanceVerdictsEarned before effects)
    (criteria : ∀ id, before.acceptanceCriteria id ⊆ after.acceptanceCriteria id)
    (verdicts : ∀ id, after.acceptanceVerdicts id ⊆ before.acceptanceVerdicts id) :
    AcceptanceVerdictsEarned after effects := by
  intro accId verdict member
  obtain ⟨runId, criterion, outcome, declared, sameId, receipt⟩ :=
    earned accId verdict (verdicts _ member)
  exact ⟨runId, criterion, outcome, criteria _ declared, sameId, receipt⟩

private theorem earned_of_stable_criteria {before after : GraphStore} {effects}
    (earned : AcceptanceVerdictsEarned before effects)
    (criteria : ∀ id, after.acceptanceCriteria id = before.acceptanceCriteria id)
    (verdicts : ∀ id, after.acceptanceVerdicts id ⊆ before.acceptanceVerdicts id) :
    AcceptanceVerdictsEarned after effects := by
  refine earned_of_extension earned (fun id entry member => ?_) verdicts
  rw [criteria id]
  exact member

private theorem criteria_mono_of_run_open {before after : GraphStore}
    {runId : RunId} {opened : Run}
    (runFresh : before.runs runId = none)
    (runs : after.runs = tableSet before.runs runId opened) :
    ∀ id, before.acceptanceCriteria id ⊆ after.acceptanceCriteria id := by
  obtain ⟨_, otherCriteria⟩ := criteria_of_run_open runs
  intro id criterion member
  by_cases same : id = runId
  · rw [same] at member
    simp [GraphStore.acceptanceCriteria, runFresh] at member
  · rw [otherCriteria id same]
    exact member

private theorem earned_of_record {before : GraphStore} {effects}
    {runId : RunId} {run : Run} {criterion : AcceptanceCriterion} {verdict : AcceptanceVerdict}
    {outcome : AttemptOutcome}
    (earned : AcceptanceVerdictsEarned before effects)
    (runLookup : before.runs runId = some run)
    (declared : criterion ∈ run.acceptance)
    (criterionId : criterion.id = verdict.acceptance)
    (receipt : VerifierReceipt effects verdict.receipt criterion.operation outcome) :
    AcceptanceVerdictsEarned (before.recordVerdict verdict) effects := by
  have criteria : ∀ id, (before.recordVerdict verdict).acceptanceCriteria id =
      before.acceptanceCriteria id := fun _ => rfl
  have inCriteria : criterion ∈ (before.recordVerdict verdict).acceptanceCriteria runId := by
    rw [criteria]
    simp [GraphStore.acceptanceCriteria, runLookup]
    exact declared
  intro accId entry member
  by_cases same : accId = verdict.acceptance
  · rw [same, record_verdict_at_criterion] at member
    rcases List.mem_cons.mp member with isVerdict | prior
    · exact ⟨runId, criterion, outcome, inCriteria, by rw [same]; exact criterionId,
        by rw [isVerdict]; exact receipt⟩
    · obtain ⟨owner, declaredCriterion, priorOutcome, ownerDeclared, sameId, priorReceipt⟩ :=
        earned verdict.acceptance entry prior
      exact ⟨owner, declaredCriterion, priorOutcome, by rw [criteria]; exact ownerDeclared,
        by rw [same]; exact sameId, priorReceipt⟩
  · rw [record_verdict_elsewhere same] at member
    obtain ⟨owner, declaredCriterion, priorOutcome, ownerDeclared, sameId, priorReceipt⟩ :=
      earned accId entry member
    exact ⟨owner, declaredCriterion, priorOutcome, by rw [criteria]; exact ownerDeclared, sameId,
      priorReceipt⟩

theorem graph_step_preserves_earned_verdicts {effects events audit before after label}
    (earned : AcceptanceVerdictsEarned before effects)
    (step : GraphStep effects events audit before label after) :
    AcceptanceVerdictsEarned after effects := by
  cases step with
  | startTurn | claimTurn | suspendTurn | resumeTurn | append | reserveObligation
  | completeObligation | beginTerminalization | forceCancelSibling =>
      exact earned_of_extension earned (fun _ => List.Subset.refl _) (fun _ => List.Subset.refl _)
  | startRun runFresh branchFresh commitFresh registryFresh rootEq active valid nodup fresh
      rootRun rootBranch rootPins writer parents kind cause =>
      exact earned_of_extension earned (criteria_mono_of_run_open runFresh rfl)
        (fun _ => List.Subset.refl _)
  | spawnChild parentLookup running exactTurn admits runFresh branchFresh commitFresh
      registryFresh childParent childRoot active nodup fresh rootRun rootBranch rootPins writer
      parents kind cause =>
      exact earned_of_extension earned (criteria_mono_of_run_open runFresh rfl)
        (fun _ => List.Subset.refl _)
  | migrate runLookup active commitFresh commitRun branchOwned headLookup parents closed allowed
      kindValid =>
      exact earned_of_stable_criteria earned (criteria_stable_of_run_update runLookup rfl rfl)
        (fun _ => List.Subset.refl _)
  | recordAcceptanceVerdict runLookup active declared criterionId registryLookup accepting
      reserved notCompleted admissible receipt =>
      exact earned_of_record earned runLookup declared criterionId receipt
  | terminalize runLookup active turnLookup turnRun running exactTurn admits validPins turnPins
      controlLookup controlTurn siblings fence outcome headLookup preterminalLookup
      preterminalRun preterminalPins commitFresh registryLookup accepting commitRun commitBranch
      commitPins writer cause parents subjectTurn kindEq snapshotEq =>
      exact earned_of_stable_criteria earned (criteria_stable_of_run_update runLookup rfl rfl)
        (fun _ => List.Subset.refl _)

private theorem agreement_of_registry_update {before after : GraphStore}
    {runId : RunId} {registry updated : RunAdmissionRegistry}
    (agreed : TerminalSnapshotsMatchRegistry before)
    (registryLookup : before.admissionRegistry runId = some registry)
    (accepting : registry.accepting = true)
    (snapshots : after.terminalSnapshots = before.terminalSnapshots)
    (registries : after.admissionRegistry = tableSet before.admissionRegistry runId updated) :
    TerminalSnapshotsMatchRegistry after := by
  intro candidate snapshot snapshotLookup
  rw [snapshots] at snapshotLookup
  obtain ⟨prior, priorLookup, closed, exactly⟩ := agreed candidate snapshot snapshotLookup
  by_cases same : candidate = runId
  · subst same
    rw [registryLookup] at priorLookup
    cases Option.some.inj priorLookup
    rw [accepting] at closed
    contradiction
  · exact ⟨prior, by rw [registries, tableSet_other _ _ _ same]; exact priorLookup, closed, exactly⟩

private theorem agreement_of_fresh_registry {before after : GraphStore}
    {runId : RunId} {opened : RunAdmissionRegistry}
    (agreed : TerminalSnapshotsMatchRegistry before)
    (registryFresh : before.admissionRegistry runId = none)
    (snapshots : after.terminalSnapshots = before.terminalSnapshots)
    (registries : after.admissionRegistry = tableSet before.admissionRegistry runId opened) :
    TerminalSnapshotsMatchRegistry after := by
  intro candidate snapshot snapshotLookup
  rw [snapshots] at snapshotLookup
  obtain ⟨prior, priorLookup, closed, exactly⟩ := agreed candidate snapshot snapshotLookup
  by_cases same : candidate = runId
  · subst same
    rw [registryFresh] at priorLookup
    contradiction
  · exact ⟨prior, by rw [registries, tableSet_other _ _ _ same]; exact priorLookup, closed, exactly⟩

private theorem agreement_of_terminalization {before after : GraphStore}
    {runId : RunId} {registry : RunAdmissionRegistry} {snapshot : TerminalSnapshot}
    (agreed : TerminalSnapshotsMatchRegistry before)
    (captured : snapshot.obligations = registry.outstanding)
    (snapshots : after.terminalSnapshots = tableSet before.terminalSnapshots runId snapshot)
    (registries : after.admissionRegistry =
      tableSet before.admissionRegistry runId registry.close) :
    TerminalSnapshotsMatchRegistry after := by
  intro candidate recorded recordedLookup
  rw [snapshots] at recordedLookup
  by_cases same : candidate = runId
  · subst same
    rw [tableSet_self] at recordedLookup
    cases Option.some.inj recordedLookup
    refine ⟨registry.close, by rw [registries]; exact tableSet_self .., rfl, fun obligation => ?_⟩
    rw [captured]
    simp [RunAdmissionRegistry.outstanding, RunAdmissionRegistry.close, List.mem_filter]
  · rw [tableSet_other _ _ _ same] at recordedLookup
    obtain ⟨prior, priorLookup, closed, exactly⟩ := agreed candidate recorded recordedLookup
    exact ⟨prior, by rw [registries, tableSet_other _ _ _ same]; exact priorLookup, closed, exactly⟩

theorem graph_step_preserves_snapshot_registry_agreement
    {effects events audit before after label}
    (agreed : TerminalSnapshotsMatchRegistry before)
    (step : GraphStep effects events audit before label after) :
    TerminalSnapshotsMatchRegistry after := by
  cases step with
  | startTurn | claimTurn | suspendTurn | resumeTurn | append | migrate
  | beginTerminalization | forceCancelSibling | recordAcceptanceVerdict => exact agreed
  | startRun runFresh branchFresh commitFresh registryFresh =>
      exact agreement_of_fresh_registry agreed registryFresh rfl rfl
  | spawnChild parentLookup running exactTurn admits runFresh branchFresh commitFresh
      registryFresh =>
      exact agreement_of_fresh_registry agreed registryFresh rfl rfl
  | reserveObligation runLookup active registryLookup accepting =>
      exact agreement_of_registry_update agreed registryLookup accepting rfl rfl
  | completeObligation runLookup active registryLookup accepting =>
      exact agreement_of_registry_update agreed registryLookup accepting rfl rfl
  | terminalize runLookup active turnLookup turnRun running exactTurn admits validPins turnPins
      controlLookup controlTurn siblings fence outcome headLookup preterminalLookup
      preterminalRun preterminalPins commitFresh registryLookup accepting commitRun commitBranch
      commitPins writer cause parents subjectTurn kindEq snapshotEq =>
      exact agreement_of_terminalization agreed (by rw [snapshotEq]) rfl rfl

inductive GraphReachable (effects : EffectLedger) (events : EventStore) (audit : AuditLog) :
    GraphStore → GraphStore → Prop
  | refl (store) : GraphReachable effects events audit store store
  | step {start middle finish label} :
      GraphReachable effects events audit start middle →
      GraphStep effects events audit middle label finish →
      GraphReachable effects events audit start finish

theorem graph_reachable_preserves_acceptance_outstanding {effects events audit start finish}
    (outstanding : AcceptanceObligationsOutstanding start)
    (reachable : GraphReachable effects events audit start finish) :
    AcceptanceObligationsOutstanding finish := by
  induction reachable with
  | refl => exact outstanding
  | step _ transition ih => exact graph_step_preserves_acceptance_outstanding ih transition

theorem graph_reachable_preserves_acceptance_criteria_unique {effects events audit start finish}
    (unique : AcceptanceCriteriaUnique start)
    (reachable : GraphReachable effects events audit start finish) :
    AcceptanceCriteriaUnique finish := by
  induction reachable with
  | refl => exact unique
  | step _ transition ih => exact graph_step_preserves_acceptance_criteria_unique ih transition

theorem graph_reachable_preserves_earned_verdicts {effects events audit start finish}
    (earned : AcceptanceVerdictsEarned start effects)
    (reachable : GraphReachable effects events audit start finish) :
    AcceptanceVerdictsEarned finish effects := by
  induction reachable with
  | refl => exact earned
  | step _ transition ih => exact graph_step_preserves_earned_verdicts ih transition

theorem graph_reachable_preserves_snapshot_registry_agreement {effects events audit start finish}
    (agreed : TerminalSnapshotsMatchRegistry start)
    (reachable : GraphReachable effects events audit start finish) :
    TerminalSnapshotsMatchRegistry finish := by
  induction reachable with
  | refl => exact agreed
  | step _ transition ih => exact graph_step_preserves_snapshot_registry_agreement ih transition

theorem no_run_graph_acceptance_is_outstanding {store} (empty : ∀ id, store.runs id = none) :
    AcceptanceObligationsOutstanding store := by
  intro runId criterion declared
  simp [GraphStore.acceptanceCriteria, empty runId] at declared

theorem no_snapshot_graph_matches_registry {store}
    (empty : ∀ id, store.terminalSnapshots id = none) : TerminalSnapshotsMatchRegistry store := by
  intro runId snapshot lookup
  rw [empty runId] at lookup
  contradiction

theorem empty_graph_acceptance_is_outstanding :
    AcceptanceObligationsOutstanding (default : GraphStore) :=
  no_run_graph_acceptance_is_outstanding (fun _ => rfl)

theorem empty_graph_acceptance_criteria_unique :
    AcceptanceCriteriaUnique (default : GraphStore) := by
  intro leftRun _ left _ leftMem _ _
  have runsEmpty : (default : GraphStore).runs leftRun = none := rfl
  simp [GraphStore.acceptanceCriteria, runsEmpty] at leftMem

theorem empty_graph_verdicts_earned {effects} :
    AcceptanceVerdictsEarned (default : GraphStore) effects := by
  intro accId verdict member
  have empty : (default : GraphStore).acceptanceVerdicts accId = [] := rfl
  rw [empty] at member
  cases member

theorem empty_graph_snapshots_match_registry :
    TerminalSnapshotsMatchRegistry (default : GraphStore) :=
  no_snapshot_graph_matches_registry (fun _ => rfl)

theorem delivery_commit_matches_route {store effects events audit now commit operation reservation outcome}
    (allowed : CommitAllowed store effects events audit now commit)
    (kind : commit.kind = .deliveryEvidence operation reservation outcome) :
    DeliveryEvidence effects events reservation operation outcome commit.run commit.subjectTurn := by
  cases writerEq : commit.writer with
  | root cause => simp [CommitAllowed, kind, writerEq] at allowed
  | turn token cause => simp [CommitAllowed, kind, writerEq] at allowed
  | system cause =>
      cases cause <;> simp [CommitAllowed, kind, writerEq] at allowed
      exact allowed.2.2.2

theorem system_control_writer_uses_exact_typed_audit {store effects events audit now commit operation receipt}
    (allowed : CommitAllowed store effects events audit now commit)
    (kind : commit.kind = .control operation receipt) :
    ∃ cause, commit.writer = .system (.control cause receipt) ∧
      ControlCommitAudit store effects audit cause receipt operation commit.run := by
  cases writerEq : commit.writer with
  | root cause => simp [CommitAllowed, kind, writerEq] at allowed
  | turn token cause => simp [CommitAllowed, kind, writerEq] at allowed
  | system cause =>
      cases cause with
      | control auditId exactReceipt =>
          unfold CommitAllowed at allowed
          rw [kind, writerEq] at allowed
          rcases allowed with ⟨rfl, typed, unary, success⟩
          exact ⟨auditId, rfl, typed⟩
      | receipt | delivery => simp [CommitAllowed, kind, writerEq] at allowed

theorem synthesis_is_system_controlled_exact_turn {store effects events audit now commit operation
    control synthesis token result tree}
    (allowed : CommitAllowed store effects events audit now commit)
    (kind : commit.kind = .merge (.synthesize operation control synthesis token result) (.clean tree)) :
    ∃ cause, commit.writer = .system (.control cause control) ∧
      ControlCommitAudit store effects audit cause control operation commit.run ∧
      SuccessfulControl effects control operation commit.run ∧
      SuccessfulSynthesis effects synthesis operation commit.run token result ∧
      commit.subjectTurn = some token.turn := by
  cases writerEq : commit.writer with
  | root cause => simp [CommitAllowed, kind, writerEq] at allowed
  | turn token cause => simp [CommitAllowed, kind, writerEq] at allowed
  | system cause =>
      cases cause with
      | control auditId receipt =>
          unfold CommitAllowed at allowed
          rw [kind, writerEq] at allowed
          change receipt = control ∧
            ControlCommitAudit store effects audit auditId control operation commit.run ∧
            SuccessfulControl effects control operation commit.run ∧
            SuccessfulSynthesis effects synthesis operation commit.run token result ∧
            commit.subjectTurn = some token.turn at allowed
          rcases allowed with ⟨rfl, auditEvidence, controlEvidence, synthesisEvidence, subject⟩
          exact ⟨auditId, rfl, auditEvidence, controlEvidence, synthesisEvidence, subject⟩
      | receipt | delivery => simp [CommitAllowed, kind, writerEq] at allowed

/-! ## Undo as append-only selection (§5.2, C13-RUN-UNDO-REDO, C13-RUN-UNDO-FENCE) -/

/-- What an undo has to bring: the branch is unheld, and the commit it selects is an ancestor
    of the parent it appends onto. -/
theorem undo_requires_unheld_branch_and_ancestor_selection
    {store effects events audit now commit selected receipt}
    (allowed : CommitAllowed store effects events audit now commit)
    (kind : commit.kind = .undo selected receipt) :
    BranchUnheld store commit.run commit.branch ∧
      ∃ parent, parent ∈ commit.parents ∧ Ancestor store selected parent := by
  cases writerEq : commit.writer with
  | root cause => simp [CommitAllowed, kind, writerEq] at allowed
  | turn token cause => simp [CommitAllowed, kind, writerEq] at allowed
  | system cause =>
      cases cause with
      | control auditId exactReceipt =>
          unfold CommitAllowed at allowed
          rw [kind, writerEq] at allowed
          exact allowed.2.2.2
      | receipt | delivery => simp [CommitAllowed, kind, writerEq] at allowed

/-- The graph is append-only in the strongest sense the model can state: no transition of any
    kind removes a commit or rewrites one that is already stored. -/
theorem graph_step_preserves_commits {effects events audit before after label id record}
    (step : GraphStep effects events audit before label after)
    (present : before.commits id = some record) : after.commits id = some record := by
  have extend : ∀ (key : CommitId) (added : RunCommit), before.commits key = none →
      tableSet before.commits key added id = some record := by
    intro key added absent
    by_cases same : id = key
    · rw [same, absent] at present
      exact (by cases present)
    · rw [tableSet_other _ _ _ same]
      exact present
  cases step with
  | startTurn | claimTurn | suspendTurn | resumeTurn | reserveObligation | completeObligation
  | recordAcceptanceVerdict | beginTerminalization | forceCancelSibling => exact present
  | startRun _ _ commitFresh => exact extend _ _ commitFresh
  | spawnChild _ _ _ _ _ _ commitFresh => exact extend _ _ commitFresh
  | append commitFresh => exact extend _ _ commitFresh
  | migrate _ _ commitFresh => exact extend _ _ commitFresh
  | terminalize _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ commitFresh => exact extend _ _ commitFresh

theorem graph_reachable_preserves_commits {effects events audit start finish id record}
    (reachable : GraphReachable effects events audit start finish)
    (present : start.commits id = some record) : finish.commits id = some record := by
  induction reachable with
  | refl => exact present
  | step _ transition ih => exact graph_step_preserves_commits transition ih

/-- Ancestry only ever grows: a graph that keeps every commit keeps every ancestry edge. -/
theorem ancestor_preserved_by_commit_growth {before after : GraphStore} {ancestor child}
    (growth : ∀ id record, before.commits id = some record → after.commits id = some record)
    (chain : Ancestor before ancestor child) : Ancestor after ancestor child := by
  induction chain with
  | refl lookup => exact .refl (growth _ _ lookup)
  | parent lookup member _ ih => exact .parent (growth _ _ lookup) member ih

/-- A commit that was not in the graph and is in it after one table write is exactly the commit
    that write added. -/
private theorem written_commit_is_the_added_one {before : GraphStore} {key : CommitId}
    {added : RunCommit} {id commit} (absent : before.commits id = none)
    (introduced : tableSet before.commits key added id = some commit) : added = commit := by
  by_cases same : id = key
  · subst same
    exact Option.some.inj ((tableSet_self ..).symm.trans introduced)
  · rw [tableSet_other _ _ _ same, absent] at introduced
    exact (by cases introduced)

/-- C13-RUN-UNDO-FENCE. No transition, under any label, puts an undo commit into a graph whose
    target branch still has a held Turn. The refusal reads the holder and the status, never the
    expiry, so an expired-but-unfenced lease blocks the undo exactly as a live one does. -/
theorem undo_fences_held_turn {effects events audit before after label id commit selected receipt
    turn}
    (step : GraphStep effects events audit before label after)
    (fresh : before.commits id = none)
    (introduced : after.commits id = some commit)
    (kind : commit.kind = .undo selected receipt)
    (held : BranchHeldBy before commit.run commit.branch turn) : False := by
  cases step with
  | startTurn | claimTurn | suspendTurn | resumeTurn | reserveObligation | completeObligation
  | recordAcceptanceVerdict | beginTerminalization | forceCancelSibling =>
      have direct : before.commits id = some commit := introduced
      rw [fresh] at direct
      exact (by cases direct)
  | startRun _ _ _ _ _ _ _ _ _ _ _ _ _ _ rootKind =>
      rw [written_commit_is_the_added_one fresh introduced, kind] at rootKind
      exact RunCommitKind.noConfusion rootKind
  | spawnChild _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ rootKind =>
      rw [written_commit_is_the_added_one fresh introduced, kind] at rootKind
      exact RunCommitKind.noConfusion rootKind
  | append _ _ _ _ _ _ _ _ allowed =>
      rw [written_commit_is_the_added_one fresh introduced] at allowed
      exact (undo_requires_unheld_branch_and_ancestor_selection allowed kind).1 turn held
  | migrate _ _ _ _ _ _ _ _ _ kindEq =>
      obtain ⟨pins, operation, migrationReceipt, migrationKind, _⟩ := kindEq
      rw [written_commit_is_the_added_one fresh introduced, kind] at migrationKind
      exact RunCommitKind.noConfusion migrationKind
  | terminalize _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ kindEq _ =>
      rw [written_commit_is_the_added_one fresh introduced, kind] at kindEq
      exact RunCommitKind.noConfusion kindEq

/-- Expiry is not a fence. A Turn whose lease has run out admits no token at all, and still
    holds its branch, so the undo above is still refused. -/
theorem expired_lease_still_holds_branch {store : GraphStore} {run branch turnId record now}
    (lookup : store.turns turnId = some record) (sameRun : record.run = run)
    (sameBranch : record.branch = branch) (running : record.status = .running)
    (holder : record.lease.holder ≠ none)
    (expired : record.lease.expiresAt.tick ≤ now.tick) :
    (∀ token, ¬ record.lease.Admits token now) ∧ BranchHeldBy store run branch turnId :=
  ⟨fun _ => expired_lease_rejects expired, ⟨record, lookup, sameRun, sameBranch, running, holder⟩⟩

/-- Fencing is what releases the branch: the system cancellation clears the sibling's holder
    atomically, so no Turn holds the branch through it afterwards. -/
theorem forced_cancellation_unblocks_undo {effects events audit before after run terminalTurn
    sibling}
    (step : GraphStep effects events audit before
      (.forceCancelSibling run terminalTurn sibling) after) :
    ∀ branch, ¬ BranchHeldBy after run branch sibling := by
  obtain ⟨prior, cancelled, evidence, priorLookup, cancelledLookup, status, unheld, _⟩ :=
    forced_cancellation_is_system_fence step
  intro branch ⟨record, lookup, _, _, running, holder⟩
  rw [cancelledLookup] at lookup
  cases Option.some.inj lookup
  exact holder unheld

/-- Appending an undo keeps everything: every stored commit survives, the head advances to the
    undo commit itself, and both the head it replaced and the commit it selects stay reachable
    as ancestors of the new head (§5.2, C13-RUN-UNDO-REDO). -/
theorem undo_keeps_prior_head_reachable {effects events audit before after id expected commit
    selected receipt}
    (step : GraphStep effects events audit before (.append id expected commit) after)
    (kind : commit.kind = .undo selected receipt) :
    (∀ commitId record, before.commits commitId = some record →
        after.commits commitId = some record) ∧
      after.heads commit.branch = some id ∧ after.commits id = some commit ∧
      Ancestor after expected id ∧ Ancestor after selected id := by
  have growth : ∀ commitId record, before.commits commitId = some record →
      after.commits commitId = some record :=
    fun _ _ present => graph_step_preserves_commits step present
  cases step with
  | append commitFresh _ _ _ _ _ closed shape allowed =>
      have parents : commit.parents = [expected] := by
        rw [kind] at shape; exact shape
      obtain ⟨parentRecord, parentLookup, _⟩ := closed expected (by rw [parents]; simp)
      obtain ⟨_, parent, member, ancestry⟩ :=
        undo_requires_unheld_branch_and_ancestor_selection allowed kind
      obtain rfl : parent = expected := by
        rw [parents] at member; simpa using member
      have head : (before.append id commit).heads commit.branch = some id := tableSet_self ..
      have stored : (before.append id commit).commits id = some commit := tableSet_self ..
      exact ⟨growth, head, stored,
        .parent stored (by rw [parents]; simp) (.refl (growth _ _ parentLookup)),
        .parent stored (by rw [parents]; simp)
          (ancestor_preserved_by_commit_growth growth ancestry)⟩

/-- The selection semantics: after the undo the branch head is the undo commit and the branch's
    effective state is exactly the commit it selected (§5.2). -/
theorem undo_selects_effective_state {effects events audit before after id expected commit
    selected receipt}
    (step : GraphStep effects events audit before (.append id expected commit) after)
    (kind : commit.kind = .undo selected receipt) :
    after.heads commit.branch = some id ∧ after.effectiveState commit.branch = some selected := by
  obtain ⟨_, head, stored, _, _⟩ := undo_keeps_prior_head_reachable step kind
  exact ⟨head, by simp [GraphStore.effectiveState, head, stored, kind]⟩

/-- Redo is another undo commit selecting the commit the first one displaced, so the pair is a
    round trip: the branch is effectively back where it started, and every commit written along
    the way -- including both undo markers -- is still in the graph (§5.2). -/
theorem undo_then_redo_restores_effective_state {effects events audit before middle after
    undoId redoId expected undoCommit redoCommit selected receipt redoReceipt}
    (priorEffective : before.effectiveState undoCommit.branch = some expected)
    (undoStep : GraphStep effects events audit before (.append undoId expected undoCommit) middle)
    (undoKind : undoCommit.kind = .undo selected receipt)
    (redoStep : GraphStep effects events audit middle (.append redoId undoId redoCommit) after)
    (redoKind : redoCommit.kind = .undo expected redoReceipt)
    (sameBranch : redoCommit.branch = undoCommit.branch) :
    middle.effectiveState undoCommit.branch = some selected ∧
      after.effectiveState undoCommit.branch = before.effectiveState undoCommit.branch ∧
      (∀ id record, before.commits id = some record → after.commits id = some record) := by
  obtain ⟨_, restored⟩ := undo_selects_effective_state redoStep redoKind
  rw [sameBranch] at restored
  refine ⟨(undo_selects_effective_state undoStep undoKind).2, restored.trans priorEffective.symm,
    fun id record present => graph_step_preserves_commits redoStep
      (graph_step_preserves_commits undoStep present)⟩

end AgentCore
