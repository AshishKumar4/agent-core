/-
Run commits and the §5.2 writer matrix (`packages/agent-core/src/agents/runs/commit.ts`).

Every Run commit names a writer, and the writer decides which kinds it may append. The
runtime states the matrix three times over — `TURN_AUTHORED_KINDS`, `CONTROL_AUTHORED_KINDS`,
and the branches of `validateCommitWriter` — and the kernel states it once, as a total
function from kind to writer class. `writerAdmits` is then that function read as a decision,
so the three runtime statements cannot drift apart here.

What this module does *not* model is the evidence lookup: `validateCommitWriter` also checks
that the named Receipt, delivery, or control Receipt exists in the ledger and binds this
exact commit, which is a question about durable state rather than about the matrix. Those
are the `authority.denied` refusals in the runtime, and they belong to the layer that holds
the ledger. The matrix refusals — the `run.invalid-state` ones — are here, complete.

The refinement theorem is the interesting one: the abstract model's `CommitAllowed` is
`False` for every kind/writer pair outside its own matrix, so from *any* model commit the
model admits, the kernel's matrix agrees about the writer class. The kernel matrix is
therefore not a restatement to be kept in sync; it is a consequence.
-/
import AgentCore.RunGraph
import AgentCore.Kernel.Runs.Lease

namespace AgentCore.Kernel

/-- Every Run commit kind, in the order `RUN_COMMIT_KINDS` lists them. -/
inductive RunCommitKind where
  | root
  | message
  | checkpoint
  | invocation
  | eventDelivery
  | result
  | merge
  | verdict
  | undo
  | migration
  | rewrite
  | modelInput
  deriving DecidableEq, Repr

namespace RunCommitKind

def wire : RunCommitKind → String
  | .root => "root"
  | .message => "message"
  | .checkpoint => "checkpoint"
  | .invocation => "invocation"
  | .eventDelivery => "eventDelivery"
  | .result => "result"
  | .merge => "merge"
  | .verdict => "verdict"
  | .undo => "undo"
  | .migration => "migration"
  | .rewrite => "rewrite"
  | .modelInput => "modelInput"

def all : List RunCommitKind :=
  [.root, .message, .checkpoint, .invocation, .eventDelivery, .result, .merge, .verdict,
   .undo, .migration, .rewrite, .modelInput]

theorem mem_all (kind : RunCommitKind) : kind ∈ all := by cases kind <;> decide

/-- **Commit kinds are distinguishable on the wire.** -/
theorem wire_nodup : (all.map wire).Nodup := by decide

/-- `TURN_AUTHORED_KINDS`: what a Turn's own lease may append. -/
def turnAuthored : RunCommitKind → Bool
  | .message | .modelInput | .checkpoint | .result | .verdict => true
  | _ => false

/-- `CONTROL_AUTHORED_KINDS`: what a system writer may append on control evidence. -/
def controlAuthored : RunCommitKind → Bool
  | .merge | .undo | .migration | .rewrite => true
  | _ => false

/-- **No kind is both Turn-authored and control-authored.** This is the §5.2 rule that
system evidence never impersonates a Turn, read off the matrix rather than asserted. -/
theorem authored_disjoint (kind : RunCommitKind) :
    ¬(turnAuthored kind = true ∧ controlAuthored kind = true) := by
  cases kind <;> simp [turnAuthored, controlAuthored]

end RunCommitKind

/-- Who may append a commit. -/
inductive WriterClass where
  /-- The Run's genesis writer. -/
  | rootWriter
  /-- A Turn, under its own lease token. -/
  | turnWriter
  /-- The system, on named durable evidence. -/
  | systemWriter
  deriving DecidableEq, Repr

/-- The single statement of the matrix: which class of writer a kind belongs to. -/
def writerClassFor : RunCommitKind → WriterClass
  | .root => .rootWriter
  | .message | .modelInput | .checkpoint | .result | .verdict => .turnWriter
  | .invocation | .eventDelivery | .merge | .undo | .migration | .rewrite => .systemWriter

/-- **Turn-authored kinds are exactly the Turn writer's column.** -/
theorem turnAuthored_iff (kind : RunCommitKind) :
    RunCommitKind.turnAuthored kind = true ↔ writerClassFor kind = .turnWriter := by
  cases kind <;> simp [RunCommitKind.turnAuthored, writerClassFor]

/-- **Control-authored kinds sit in the system writer's column.** The system column is
wider than the control row: `invocation` and `eventDelivery` are system-written on Receipt
and delivery evidence rather than on control evidence. -/
theorem controlAuthored_system (kind : RunCommitKind)
    (control : RunCommitKind.controlAuthored kind = true) :
    writerClassFor kind = .systemWriter := by
  cases kind <;> simp_all [RunCommitKind.controlAuthored, writerClassFor]

/-- The system cause a system writer stands on. -/
inductive SystemCause where
  | receipt (audit : TextId .auditRecord) (receipt : TextId .receipt)
  | delivery (audit : TextId .auditRecord) (reservation : TextId .routeReservation)
  | control (audit : TextId .auditRecord) (receipt : TextId .receipt)
  deriving DecidableEq

/-- The writer a commit names. -/
inductive CommitWriter where
  | root
  | turn (token : LeaseToken)
  | system (cause : SystemCause)

namespace CommitWriter

/-- The class of this writer. -/
def class' : CommitWriter → WriterClass
  | .root => .rootWriter
  | .turn _ => .turnWriter
  | .system _ => .systemWriter

/-- Which kinds each system cause admits: a Receipt cause carries an `invocation` commit, a
delivery cause an `eventDelivery` commit, and a control cause the control-authored kinds. -/
def causeAdmits : SystemCause → RunCommitKind → Bool
  | .receipt _ _, kind => kind == .invocation
  | .delivery _ _, kind => kind == .eventDelivery
  | .control _ _, kind => RunCommitKind.controlAuthored kind

/-- `validateCommitWriter`'s matrix decision. The evidence lookups the runtime performs on
top of this are a question about the ledger, not about the matrix, and are refused with
`authority.denied` by the layer that holds it. -/
def admits (writer : CommitWriter) (kind : RunCommitKind) : Bool :=
  match writer with
  | .root => kind == .root
  | .turn _ => RunCommitKind.turnAuthored kind
  | .system cause => causeAdmits cause kind

end CommitWriter

/-- The matrix as a decision: admit, or refuse with the code the runtime raises. A Turn
writer that also fails to name its own Turn as the subject is refused by
`subjectAdmits` below with the same code, exactly as `validateCommitWriter` does. -/
def admitWriter (writer : CommitWriter) (kind : RunCommitKind) : Outcome Unit :=
  if writer.admits kind then .ok () else refuse .runInvalidState

/-- A Turn writer's commit names that Turn as its subject (§5.2). -/
def subjectAdmits (writer : CommitWriter) (subjectTurn : Option (TextId .turn)) : Bool :=
  match writer with
  | .turn token => subjectTurn == some token.turn
  | _ => true

/-- The whole Turn-writer rule: an admitted kind *and* the exact subject Turn. -/
def admitTurnWriter (writer : CommitWriter) (kind : RunCommitKind)
    (subjectTurn : Option (TextId .turn)) : Outcome Unit :=
  if writer.admits kind && subjectAdmits writer subjectTurn then .ok ()
  else refuse .runInvalidState

/-- **The root writer may append only the root commit.** -/
theorem root_writer_only_root {kind : RunCommitKind} (notRoot : kind ≠ .root) :
    (admitWriter .root kind).RefusedWith .runInvalidState := by
  unfold admitWriter CommitWriter.admits
  simp [notRoot, refuse, Outcome.RefusedWith]

/-- **The root commit has no other writer.** Neither a Turn nor the system may author
genesis, so a Run's first commit is unforgeable. -/
theorem root_commit_only_root_writer (token : LeaseToken) (cause : SystemCause) :
    (admitWriter (.turn token) .root).RefusedWith .runInvalidState ∧
      (admitWriter (.system cause) .root).RefusedWith .runInvalidState := by
  refine ⟨?_, ?_⟩
  · simp [admitWriter, CommitWriter.admits, RunCommitKind.turnAuthored, refuse,
      Outcome.RefusedWith]
  · cases cause <;>
      simp [admitWriter, CommitWriter.admits, CommitWriter.causeAdmits,
        RunCommitKind.controlAuthored, refuse, Outcome.RefusedWith]

/-- **A Turn never authors a control commit.** Merge, undo, migration, and rewrite are
system-authored on control evidence; a Turn token cannot append one. -/
theorem turn_writer_refuses_control {kind : RunCommitKind} (token : LeaseToken)
    (control : RunCommitKind.controlAuthored kind = true) :
    (admitWriter (.turn token) kind).RefusedWith .runInvalidState := by
  have notTurn : RunCommitKind.turnAuthored kind = false := by
    cases kind <;> simp_all [RunCommitKind.turnAuthored, RunCommitKind.controlAuthored]
  unfold admitWriter CommitWriter.admits
  simp [notTurn, refuse, Outcome.RefusedWith]

/-- **System evidence never impersonates a Turn.** A control cause admits no Turn-authored
kind, so system-authored evidence cannot masquerade as a Turn's own transcript entry. -/
theorem control_cause_refuses_turn_authored {kind : RunCommitKind}
    (audit : TextId .auditRecord) (receipt : TextId .receipt)
    (turnKind : RunCommitKind.turnAuthored kind = true) :
    (admitWriter (.system (.control audit receipt)) kind).RefusedWith .runInvalidState := by
  have notControl : RunCommitKind.controlAuthored kind = false := by
    cases kind <;> simp_all [RunCommitKind.turnAuthored, RunCommitKind.controlAuthored]
  unfold admitWriter CommitWriter.admits CommitWriter.causeAdmits
  simp [notControl, refuse, Outcome.RefusedWith]

/-- **A Receipt cause carries exactly one kind, and a delivery cause exactly one.** -/
theorem evidence_causes_are_exact (audit : TextId .auditRecord) (receipt : TextId .receipt)
    (reservation : TextId .routeReservation) (kind : RunCommitKind) :
    (CommitWriter.admits (.system (.receipt audit receipt)) kind = true ↔ kind = .invocation) ∧
      (CommitWriter.admits (.system (.delivery audit reservation)) kind = true ↔
        kind = .eventDelivery) := by
  refine ⟨?_, ?_⟩ <;> cases kind <;>
    simp [CommitWriter.admits, CommitWriter.causeAdmits]

/-- **An admitted commit's writer class is the one the matrix assigns its kind.** The three
runtime statements of the matrix collapse into this one fact. -/
theorem admits_determines_class {writer : CommitWriter} {kind : RunCommitKind}
    (admitted : writer.admits kind = true) : writer.class' = writerClassFor kind := by
  cases writer with
  | root =>
      have same : kind = .root := by
        simpa [CommitWriter.admits] using admitted
      rw [same]
      rfl
  | turn token =>
      have turnKind : writerClassFor kind = .turnWriter :=
        (turnAuthored_iff kind).mp (by simpa [CommitWriter.admits] using admitted)
      rw [turnKind]
      rfl
  | system cause =>
      cases cause with
      | receipt audit receipt =>
          have same : kind = .invocation := by
            simpa [CommitWriter.admits, CommitWriter.causeAdmits] using admitted
          rw [same]
          rfl
      | delivery audit reservation =>
          have same : kind = .eventDelivery := by
            simpa [CommitWriter.admits, CommitWriter.causeAdmits] using admitted
          rw [same]
          rfl
      | control audit receipt =>
          have control : RunCommitKind.controlAuthored kind = true := by
            simpa [CommitWriter.admits, CommitWriter.causeAdmits] using admitted
          rw [controlAuthored_system kind control]
          rfl

/-- The two ordered parents of a merge (§5.2): the head the merge lands on and the head of
the distinct lineage it joins. Distinctness is a field, so a merge that joins one lineage to
itself is not a value a caller can build or a decoder can restore. -/
structure MergeParents where
  target : TextId .runCommit
  source : TextId .runCommit
  distinct : target ≠ source

namespace MergeParents

/-- The pair in the order the merge declared, which is the commit's own parent list. -/
def ordered (parents : MergeParents) : List (TextId .runCommit) :=
  [parents.target, parents.source]

/-- **A merge names exactly two parents.** Tree merge is binary; there is no n-ary form to
reject later. -/
theorem ordered_length (parents : MergeParents) : parents.ordered.length = 2 := rfl

/-- **A merge names two lineages.** -/
theorem ordered_nodup (parents : MergeParents) : parents.ordered.Nodup := by
  refine List.nodup_cons.mpr ⟨?_, ?_⟩
  · simp [parents.distinct]
  · simp

def parse (target source : TextId .runCommit) : Outcome MergeParents :=
  if distinct : target ≠ source then .ok ⟨target, source, distinct⟩
  else unshaped "Merge parents"

end MergeParents

/-! ## Refinement against the model's `CommitAllowed`

`AgentCore.CommitAllowed` matches on the model's kind and writer together and is `False`
for every pair outside its matrix. Mapping the model's vocabulary onto the kernel's and
reading that fact off gives the kernel matrix as a *consequence* of the model, rather than a
second statement that has to be kept in step with it. -/

/-- The kernel kind for a model kind. Three notes on the map, because it is where the two
vocabularies genuinely differ:

* the model's `terminal` is the kernel's `result` — the commit that records a Turn's outcome;
* the model's generic `control` commit is the kernel's `rewrite`, the remaining
  control-authored kind, and both sit on the same matrix row (system writer, control cause);
* the kernel's `verdict` and `modelInput` have no model counterpart, so no model commit maps
  onto them and no theorem here claims one. -/
def kindOfModel : AgentCore.RunCommitKind → RunCommitKind
  | .root => .root
  | .message => .message
  | .checkpoint => .checkpoint
  | .terminal _ => .result
  | .invocationEvidence _ _ _ => .invocation
  | .deliveryEvidence _ _ _ => .eventDelivery
  | .control _ _ => .rewrite
  | .migration _ _ _ => .migration
  | .undo _ _ => .undo
  | .merge _ _ => .merge

/-- The writer class of a model writer. -/
def classOfModel : AgentCore.CommitWriter → WriterClass
  | .root _ => .rootWriter
  | .turn _ _ => .turnWriter
  | .system _ => .systemWriter

/-- **The kernel's writer matrix is the model's.** For every commit the abstract model
admits, the class of the writer it names is exactly the class the kernel's matrix assigns to
its kind. Nothing about the ledger is used: the pairing alone carries this. -/
theorem writer_matrix_refines_model {store effects events audit now commit}
    (allowed : AgentCore.CommitAllowed store effects events audit now commit) :
    classOfModel commit.writer = writerClassFor (kindOfModel commit.kind) := by
  obtain ⟨run, branch, pins, writer, parents, subjectTurn, kind, treeCheckpoint⟩ := commit
  cases writer with
  | root cause =>
      cases kind <;>
        first
          | rfl
          | simp [AgentCore.CommitAllowed] at allowed
          | (rename_i resolution tree
             cases resolution <;> cases tree <;> simp [AgentCore.CommitAllowed] at allowed)
  | turn token cause =>
      cases kind <;>
        first
          | rfl
          | simp [AgentCore.CommitAllowed] at allowed
          | (rename_i resolution tree
             cases resolution <;> cases tree <;> simp [AgentCore.CommitAllowed] at allowed)
  | system cause =>
      cases cause <;> cases kind <;>
        first
          | rfl
          | simp [AgentCore.CommitAllowed] at allowed
          | (rename_i resolution tree
             cases resolution <;> cases tree <;> simp [AgentCore.CommitAllowed] at allowed)

end AgentCore.Kernel
