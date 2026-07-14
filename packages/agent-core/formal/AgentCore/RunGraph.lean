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

structure Run where
  tenant : TenantId
  workspace : WorkspaceId
  agent : AgentId
  pins : RunPins
  root : CommitId
  rootBranch : BranchId
  parent : Option RunId
  status : RunStatus
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

structure RunCommit where
  run : RunId
  branch : BranchId
  pins : RunPins
  writer : CommitWriter
  parents : List CommitId
  subjectTurn : Option TurnId
  kind : RunCommitKind
  deriving DecidableEq, Repr

inductive OpenObligation where
  | approval (id : ApprovalId)
  | item (invocation : InvocationId) (index : Nat) (key : ItemKey)
  | route (reservation : ReservationId)
  | reconciliation (attempt : AttemptId)
  | systemCommit (commit : CommitId)
  deriving DecidableEq, Repr

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
  conflicts : RunId → Prop

instance : Inhabited GraphStore where
  default := ⟨fun _ => none, fun _ => none, fun _ => none, fun _ => none,
    fun _ => none, fun _ => none, fun _ => none, fun _ => none, fun _ => none,
    fun _ => False⟩

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
  | .undo selects receipt, .system (.control cause exactReceipt) =>
      exactReceipt = receipt ∧
      UnaryPinsInherited store commit ∧
      (∃ operation, ControlCommitAudit store effects audit cause receipt operation commit.run ∧
        SuccessfulControl effects receipt operation commit.run) ∧
      ∃ parent, parent ∈ commit.parents ∧ Ancestor store selects parent
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
      run.root = rootId → run.status = .active → run.pins.Valid run.agent →
      root.run = runId → root.branch = run.rootBranch →
      root.pins = run.pins → root.writer = .root cause → root.parents = [] → root.kind = .root →
      AuditCauseExists audit cause runId →
      GraphStep effects events audit store (.startRun runId rootId) {
        store with
        runs := tableSet store.runs runId run
        branches := tableSet store.branches run.rootBranch ⟨runId⟩
        commits := tableSet store.commits rootId root
        heads := tableSet store.heads run.rootBranch rootId
        admissionRegistry := tableSet store.admissionRegistry runId ⟨0, true, [], []⟩ }
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
      child.parent = some parent.run → child.root = rootId → child.status = .active →
      root.run = childId → root.branch = child.rootBranch → root.pins = child.pins →
      root.writer = .root cause → root.parents = [] → root.kind = .root →
      AuditCauseExists audit cause childId →
      GraphStep effects events audit store (.spawnChild parentId childId rootId) {
        store with
        runs := tableSet store.runs childId child
        branches := tableSet store.branches child.rootBranch ⟨childId⟩
        commits := tableSet store.commits rootId root
        heads := tableSet store.heads child.rootBranch rootId }
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
      obligation ∉ registry.reserved → obligation ∉ registry.completed →
      GraphStep effects events audit store (.reserveObligation runId registry.epoch obligation)
        (store.reserve runId registry obligation)
  | completeObligation {store runId run registry obligation} :
      store.runs runId = some run → run.status = .active →
      store.admissionRegistry runId = some registry → registry.accepting = true →
      obligation ∈ registry.reserved → obligation ∉ registry.completed →
      GraphStep effects events audit store (.completeObligation runId registry.epoch obligation)
        (store.complete runId registry obligation)
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

end AgentCore
