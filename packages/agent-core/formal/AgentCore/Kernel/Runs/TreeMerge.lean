/-
Binary merge (SPEC §5.2, §5.2.1; `packages/agent-core/src/agents/runs/commit.ts` merge
shape, `runtime.ts#mergeRunInTransaction`/`validateMerge`, `src/definition/policy.ts`).

A merge joins exactly two ordered lineages, and everything else about it follows from that.
`Runs.Commit` already carries the pair — `MergeParents`, with distinctness as a field — so
this module carries what the pair is *used for*: the conversation resolution, the tree
resolution, and the rules relating both back to the two parents.

The tree half is where the Blueprint's declared policy is consumed, and this module does not
restate that policy. `AgentCore.Extract.TreeMergePolicy` is the single Lean definition of
which side a wholesale resolution records and whether a path both branches changed is a
conflict; the TypeScript runtime imports the lowering of exactly that module. Here
`TreeMergeResolution.policy` reads a resolution back as one of those three settings,
`declaredSide` routes "which parent" through `TreeMergePolicy.side`, and `resolveTree`
routes "is this a conflict" through `TreeMergePolicy.surfacesConflicts`. There is no second
statement of either fact anywhere in this file.

Absence is not a fourth setting. A Blueprint that declares no `treeMerge` describes a
platform whose branches own disjoint Environments; a merge over a *shared* Environment then
has no side to supply and is rejected, which is C13-RUN-TREE-CONFLICT-EXPLICIT and is
`admitDeclaredTreeMerge` below. `runtime.ts#validateMerge` now enforces exactly that rule:
it reads the declaration through `RunMergePort.declaredTreeMerge`, whose answer the merge's
own `pins.effectivePolicy` fixes, and refuses with `run.invalid-state` when nothing is
declared and the merge stands over a shared tree — which is what a recorded resolution, or a
tree standing on both parents, shows. This is a mirror, not a kernel-ahead-of-TypeScript gap.

Codes, as the runtime raises them: the shape rules are `TypeError` and so are shape faults
here; `validateMerge`'s ledger rules are `run.invalid-state` (`invalidRun`), except the
current-heads check, which is `protocol.revision-conflict` because a merge landing on a head
that has moved is a stale write rather than an illegal one.
-/
import AgentCore.RunGraph
import AgentCore.Extract.TreeMerge
import AgentCore.Kernel.Runs.Commit
import AgentCore.Kernel.Runs.Pins

namespace AgentCore.Kernel

/-- `MergeResolution`: how a merge resolves the *conversation* its two parents hold. -/
inductive MergeResolution where
  /-- Copy one ordered parent's content wholesale. -/
  | pick (parent : TextId .runCommit)
  /-- Concatenate the parents' content in parent order. -/
  | concat
  /-- Synthesize new content under the spawning Turn's token, on a Receipt. -/
  | synthesize (token : LeaseToken) (receipt : TextId .receipt)

/-- One path a per-path merge resolves, and the side it takes that path from. -/
structure PathResolution where
  path : String
  side : TextId .runCommit
  deriving DecidableEq

/-- The paths a per-path resolution answers. -/
def resolutionPaths (resolutions : List PathResolution) : List String :=
  resolutions.map PathResolution.path

/-- `TreeMergeResolution`: how a merge resolves the *tree* its two parents share. The two
shapes are the runtime's discriminated union, and each carries only the fields its setting
admits — a wholesale resolution names a side and no paths, a per-path resolution names paths
and no side. -/
inductive TreeMergeResolution where
  /-- `ours` or `theirs`: one side's tree, wholesale. -/
  | wholesale (side : Extract.TreeMergeSide) (commit : TextId .runCommit) (base : ContentRef)
      (environment : String)
  /-- `perPath`: the side that changed each path, with every path answered at most once. -/
  | perPath (base : ContentRef) (environment : String) (resolutions : List PathResolution)
      (pathsUnique : (resolutionPaths resolutions).Nodup)

namespace TreeMergeResolution

/-- The declared policy this resolution was taken under. The three settings are
`Extract.TreeMergePolicy`'s, not a second vocabulary. -/
def policy : TreeMergeResolution → Extract.TreeMergePolicy
  | .wholesale .ours _ _ _ => .ours
  | .wholesale .theirs _ _ _ => .theirs
  | .perPath _ _ _ _ => .perPath

/-- The base tree the resolution was taken against: the common ancestor. -/
def base : TreeMergeResolution → ContentRef
  | .wholesale _ _ value _ => value
  | .perPath value _ _ _ => value

/-- The Environment the two trees share. -/
def environment : TreeMergeResolution → String
  | .wholesale _ _ _ value => value
  | .perPath _ value _ _ => value

/-- **A wholesale resolution's side is exactly the side its policy records.** The record
shape and `Extract.TreeMergePolicy.side` cannot disagree, because the policy is read off the
shape. -/
theorem policy_side_wholesale (side : Extract.TreeMergeSide) (commit : TextId .runCommit)
    (base : ContentRef) (environment : String) :
    (TreeMergeResolution.wholesale side commit base environment).policy.side = some side := by
  cases side <;> rfl

/-- **A per-path resolution records no side**, which by
`Extract.surfaces_conflicts_iff_no_side` is the same fact as its being the one setting that
can surface a conflict. -/
theorem policy_side_perPath (base : ContentRef) (environment : String)
    (resolutions : List PathResolution) (pathsUnique : (resolutionPaths resolutions).Nodup) :
    (TreeMergeResolution.perPath base environment resolutions pathsUnique).policy.side
      = none := rfl

/-- **Exactly a per-path resolution surfaces conflicts.** Read through Extract, so the
kernel adds no second opinion. -/
theorem surfacesConflicts_iff_perPath (resolution : TreeMergeResolution) :
    resolution.policy.surfacesConflicts = true ↔ resolution.policy.side = none :=
  Extract.surfaces_conflicts_iff_no_side

end TreeMergeResolution

namespace MergeParents

/-- Which of the two ordered parents a side names: `ours` is the head the merge lands on,
`theirs` is the head of the lineage it joins in. -/
def forSide (parents : MergeParents) : Extract.TreeMergeSide → TextId .runCommit
  | .ours => parents.target
  | .theirs => parents.source

/-- The parent a wholesale resolution takes the tree from, decided by
`Extract.TreeMergePolicy.side` and nothing else. A per-path merge has no single parent to
name, which is why this is an `Option`. -/
def declaredSide (parents : MergeParents) (policy : Extract.TreeMergePolicy) :
    Option (TextId .runCommit) :=
  (policy.side).map parents.forSide

/-- **`ours` is the target head and `theirs` is the source head.** -/
theorem declaredSide_values (parents : MergeParents) :
    parents.declaredSide .ours = some parents.target ∧
      parents.declaredSide .theirs = some parents.source ∧
        parents.declaredSide .perPath = none :=
  ⟨rfl, rfl, rfl⟩

/-- **A declared side is one of the two parents.** -/
theorem declaredSide_mem {parents : MergeParents} {policy : Extract.TreeMergePolicy}
    {commit : TextId .runCommit} (named : parents.declaredSide policy = some commit) :
    commit ∈ parents.ordered := by
  cases policy <;> simp_all [declaredSide, forSide, Extract.TreeMergePolicy.side, ordered]

end MergeParents

/-- `validateMerge`'s side rule: a wholesale resolution names exactly the parent its policy
records, and a per-path resolution names only ordered parents. -/
def treeSidesAdmitted (parents : MergeParents) (resolution : TreeMergeResolution) : Bool :=
  match resolution with
  | .wholesale side commit _ _ => parents.declaredSide (resolution.policy) == some commit &&
      (parents.forSide side == commit)
  | .perPath _ _ resolutions _ =>
      resolutions.all fun path => parents.ordered.contains path.side

/-- **A wholesale resolution is admitted exactly when its commit is the parent its policy
names.** -/
theorem treeSidesAdmitted_wholesale {parents : MergeParents} {side : Extract.TreeMergeSide}
    {commit : TextId .runCommit} {base : ContentRef} {environment : String} :
    treeSidesAdmitted parents (.wholesale side commit base environment) = true ↔
      parents.forSide side = commit := by
  unfold treeSidesAdmitted MergeParents.declaredSide
  rw [TreeMergeResolution.policy_side_wholesale]
  simp [MergeParents.forSide]

/-- A merge commit: the two ordered parents, the control evidence that authored it, the
conversation resolution, and — together or not at all — the tree resolution and the tree
checkpoint it produced. Every rule `validateCommitFields` states about a merge is a field
here, so a merge commit that breaks one is not a value. -/
structure MergeCommit where
  parents : MergeParents
  audit : TextId .auditRecord
  controlReceipt : TextId .receipt
  resolution : MergeResolution
  content : ContentRef
  receipt : TextId .receipt
  treeResolution : Option TreeMergeResolution
  treeCheckpoint : Option ContentRef
  /-- A pick names one of the two ordered parents. -/
  pickNamesParent : ∀ parent, resolution = .pick parent → parent ∈ parents.ordered
  /-- A tree resolution and the checkpoint it produced occur together or not at all. -/
  treeTogether : treeResolution.isSome = treeCheckpoint.isSome
  /-- A tree resolution's sides name the ordered merge parents. -/
  sidesNameParents : ∀ tree, treeResolution = some tree →
    treeSidesAdmitted parents tree = true

namespace MergeCommit

/-- The writer a merge commit names. A merge is system-authored on *control* evidence and
cannot be authored any other way, which is why the record carries the audit and control
Receipt rather than a general writer. -/
def writer (commit : MergeCommit) : CommitWriter :=
  .system (.control commit.audit commit.controlReceipt)

/-- **A merge commit's writer admits a merge**, by the §5.2 matrix in `Runs.Commit` rather
than by a second statement here. -/
theorem writer_admits (commit : MergeCommit) :
    commit.writer.admits .merge = true := rfl

/-- **A merge is never Turn-authored.** The record cannot name a Turn writer at all, so the
matrix refusal is unreachable rather than merely enforced. -/
theorem writer_is_system (commit : MergeCommit) :
    commit.writer.class' = writerClassFor .merge := rfl

/-- **A merge names exactly two distinct parents.** -/
theorem parents_binary (commit : MergeCommit) :
    commit.parents.ordered.length = 2 ∧ commit.parents.ordered.Nodup :=
  ⟨commit.parents.ordered_length, commit.parents.ordered_nodup⟩

/-- **A merge that resolved a tree recorded the tree it produced.** -/
theorem tree_checkpointed {commit : MergeCommit} {tree : TreeMergeResolution}
    (resolved : commit.treeResolution = some tree) : commit.treeCheckpoint.isSome = true := by
  have together := commit.treeTogether
  rw [resolved] at together
  exact together.symm

/-- **A merge that recorded no tree resolution recorded no tree checkpoint.** -/
theorem no_tree_no_checkpoint {commit : MergeCommit} (absent : commit.treeResolution = none) :
    commit.treeCheckpoint = none := by
  have together := commit.treeTogether
  rw [absent] at together
  cases shape : commit.treeCheckpoint with
  | none => rfl
  | some _ => rw [shape] at together; simp at together

end MergeCommit

/-! ## Resolving the shared tree

`resolveTree` is the whole of SPEC §5.2.1's conflict rule, and it asks
`Extract.TreeMergePolicy.surfacesConflicts` exactly once. A wholesale policy has already
answered every path by naming a side, so it never blocks; a per-path merge blocks on the
paths both sides changed and left unanswered. -/

/-- What resolving the shared tree produced: the tree, or the contested paths that stopped
it. This is the kernel's form of the model's `AgentCore.TreeResolution`. -/
inductive TreeOutcome where
  | clean (tree : ContentRef)
  | blocked (head : String) (tail : List String)
  deriving DecidableEq

/-- Resolve the shared tree under the declared policy. `contested` is the set of paths both
branches changed and the resolution did not answer; only a policy that surfaces conflicts
can be stopped by one. -/
def resolveTree (policy : Extract.TreeMergePolicy) (tree : ContentRef)
    (contested : List String) : TreeOutcome :=
  if policy.surfacesConflicts then
    match contested with
    | [] => .clean tree
    | head :: tail => .blocked head tail
  else .clean tree

/-- **A wholesale policy never blocks.** Naming a side answers every path in advance, which
is exactly why `ours` and `theirs` cannot surface a conflict. -/
theorem resolveTree_wholesale {policy : Extract.TreeMergePolicy} {tree : ContentRef}
    {contested : List String} {side : Extract.TreeMergeSide}
    (wholesale : policy.side = some side) : resolveTree policy tree contested = .clean tree := by
  have quiet : policy.surfacesConflicts = false := by
    cases shape : policy.surfacesConflicts with
    | false => rfl
    | true =>
        have none' := Extract.surfaces_conflicts_iff_no_side.mp shape
        rw [wholesale] at none'
        simp at none'
  unfold resolveTree
  simp [quiet]

/-- **A per-path merge blocks on an unanswered contested path.** -/
theorem resolveTree_perPath_blocks (tree : ContentRef) (head : String) (tail : List String) :
    resolveTree .perPath tree (head :: tail) = .blocked head tail := rfl

/-- **A per-path merge with nothing contested is clean.** -/
theorem resolveTree_perPath_clean (tree : ContentRef) :
    resolveTree .perPath tree [] = .clean tree := rfl

/-- No merge commit is appended while a tree conflict is unresolved
(C13-RUN-TREE-CONFLICT-EXPLICIT). The refusal is `run.invalid-state`, which is what
`validateMerge`'s `invalidRun` raises. -/
def admitTreeOutcome : TreeOutcome → Outcome ContentRef
  | .clean tree => .ok tree
  | .blocked _ _ => refuse .runInvalidState

/-- **A blocked tree refuses the merge.** -/
theorem admitTreeOutcome_blocked (head : String) (tail : List String) :
    (admitTreeOutcome (.blocked head tail)).RefusedWith .runInvalidState := rfl

/-- A Blueprint that declares no `treeMerge` describes branches over disjoint Environments.
Such a merge resolves no tree at all, and that is admitted. Merging two branches over one
*shared* Environment with nothing declared has no side to supply, and SPEC §5.2.1 rejects
that merge rather than guessing one. -/
def admitDeclaredTreeMerge (declared : Option Extract.TreeMergePolicy)
    (sharedEnvironment : Bool) : Outcome (Option Extract.TreeMergePolicy) :=
  match declared with
  | some policy => .ok (some policy)
  | none => if sharedEnvironment then refuse .runInvalidState else .ok none

/-- **An undeclared policy cannot merge a shared tree.** -/
theorem admitDeclaredTreeMerge_undeclared_shared :
    (admitDeclaredTreeMerge none true).RefusedWith .runInvalidState := rfl

/-- **Disjoint Environments need no declaration.** A platform whose branches never share a
tree resolves no tree, so omitting the policy is admitted rather than merely tolerated. -/
theorem admitDeclaredTreeMerge_undeclared_disjoint :
    admitDeclaredTreeMerge none false = .ok none := rfl

/-- **A declared policy is served exactly as declared.** Absence is not a fourth setting and
a declared setting is never overridden. -/
theorem admitDeclaredTreeMerge_declared (policy : Extract.TreeMergePolicy)
    (sharedEnvironment : Bool) :
    admitDeclaredTreeMerge (some policy) sharedEnvironment = .ok (some policy) := rfl

/-! ## The two ledger rules

`validateMerge` checks the parents against the store as well as against the record. Both
checks are here because both are decisions about the merge rather than about the ledger's
contents: one compares two heads, the other compares three pin sets. -/

/-- The heads a merge lands between: the target branch's current head and the distinct
source branch's. A merge whose declared parents are not those two heads is a stale write,
which is why this refusal is `protocol.revision-conflict` and not `run.invalid-state`. -/
def admitMergeHeads (parents : MergeParents) (targetHead sourceHead : TextId .runCommit) :
    Outcome Unit :=
  if parents.target == targetHead && parents.source == sourceHead then .ok ()
  else refuse .protocolRevisionConflict

/-- **A merge onto a moved head is refused as a revision conflict.** -/
theorem admitMergeHeads_stale {parents : MergeParents} {targetHead sourceHead : TextId .runCommit}
    (moved : parents.target ≠ targetHead ∨ parents.source ≠ sourceHead) :
    (admitMergeHeads parents targetHead sourceHead).RefusedWith .protocolRevisionConflict := by
  unfold admitMergeHeads
  rcases moved with target | source
  · simp [target, refuse, Outcome.RefusedWith]
  · simp [source, refuse, Outcome.RefusedWith]

/-- Whether the two heads and the merge commit carry one pin set. The runtime compares
encoded bytes and reports the divergent dimensions; the code is the same for both
comparisons, so the kernel states the decision once. -/
def mergePinsAgree (target source commit : RunPins) : Bool :=
  target == source && commit == target

/-- `validateMerge`'s pin rule: equal-pinned current heads, and a merge commit carrying
exactly those pins. Divergent pins must be migrated first, which is why this is
`run.invalid-state` rather than a conflict. -/
def admitMergePins (target source commit : RunPins) : Outcome Unit :=
  if mergePinsAgree target source commit then .ok () else refuse .runInvalidState

/-- **Divergently pinned heads cannot merge.** -/
theorem admitMergePins_divergent {target source commit : RunPins} (divergent : target ≠ source) :
    (admitMergePins target source commit).RefusedWith .runInvalidState := by
  unfold admitMergePins mergePinsAgree
  simp [divergent, refuse, Outcome.RefusedWith]

/-- **A merge commit cannot re-pin.** Its pins are its equal-pinned parents' pins; a merge
that carried different ones would be an implicit migration. -/
theorem admitMergePins_repin {target source commit : RunPins} (repinned : commit ≠ target) :
    (admitMergePins target source commit).RefusedWith .runInvalidState := by
  unfold admitMergePins mergePinsAgree
  simp [repinned, refuse, Outcome.RefusedWith]

/-- **An admitted merge has one pin set across both heads and the commit.** -/
theorem admitMergePins_agrees {target source commit : RunPins}
    (admitted : admitMergePins target source commit = .ok ()) :
    target = source ∧ commit = target := by
  unfold admitMergePins at admitted
  by_cases agree : mergePinsAgree target source commit = true
  · unfold mergePinsAgree at agree
    simp only [Bool.and_eq_true, beq_iff_eq] at agree
    exact agree
  · simp only [Bool.not_eq_true] at agree
    rw [agree] at admitted
    simp [refuse] at admitted

/-! ## Refinement against the model's merge

`AgentCore.RunCommitKind.merge` pairs a `ConversationResolution` with a `TreeResolution`,
and `AgentCore.CurrentMergeHeads` states the parent-order and equal-pin rules the runtime
enforces. Both map across under the usual explicit identifier abstraction. -/

/-- The model's conversation resolution for this one. The model's `pick` and `synthesize`
name a control Receipt the kernel's record keeps on the commit rather than on the
resolution, so the bridge takes it as a parameter — the same shape the other bridges use for
facts the executable record holds elsewhere. -/
def MergeResolution.toModel (resolution : MergeResolution) (idOf : String → Nat)
    (controlReceipt : TextId .receipt) (operationOf : LeaseToken → AgentCore.OperationId)
    (identityOf : LeaseToken → AgentCore.InvocationIdentity)
    (tokenOf : LeaseToken → AgentCore.LeaseToken) : AgentCore.ConversationResolution :=
  match resolution with
  | .pick parent => .pick ⟨idOf parent.value⟩ ⟨idOf controlReceipt.value⟩
  | .concat => .concatenate ⟨idOf controlReceipt.value⟩
  | .synthesize token receipt =>
      .synthesize (operationOf token) ⟨idOf controlReceipt.value⟩ ⟨idOf receipt.value⟩
        (tokenOf token) (identityOf token)

/-- The model's tree resolution for an outcome. -/
def TreeOutcome.toModel (outcome : TreeOutcome) (idOf : String → Nat) :
    AgentCore.TreeResolution :=
  match outcome with
  | .clean tree => .clean ⟨idOf tree.value⟩
  | .blocked head tail => .blocked head tail

/-- **A clean resolution is the model's clean resolution, and a blocked one is the model's
blocked one.** The model's `blocked` carries a nonempty list of paths by construction, which
is exactly the shape `resolveTree` produces. -/
theorem TreeOutcome.toModel_blocked_nonempty {outcome : TreeOutcome} {idOf : String → Nat}
    {head : String} {tail : List String}
    (blocked : outcome.toModel idOf = .blocked head tail) :
    outcome = .blocked head tail := by
  cases outcome with
  | clean tree => simp [toModel] at blocked
  | blocked candidateHead candidateTail =>
      simp only [toModel, AgentCore.TreeResolution.blocked.injEq] at blocked
      rw [blocked.1, blocked.2]

/-- **The kernel's admitted merge parents are the model's `CurrentMergeHeads` parent list.**
The model requires `commit.parents = [expected, sourceHead]` with the two distinct; the
kernel's `MergeParents` *is* that list, and `admitMergeHeads` is what ties it to the two
current heads. -/
theorem admitMergeHeads_refines_parents {parents : MergeParents}
    {targetHead sourceHead : TextId .runCommit}
    (admitted : admitMergeHeads parents targetHead sourceHead = .ok ()) :
    parents.ordered = [targetHead, sourceHead] ∧ targetHead ≠ sourceHead := by
  unfold admitMergeHeads at admitted
  by_cases guard : (parents.target == targetHead) && (parents.source == sourceHead)
  · obtain ⟨target, source⟩ := (Bool.and_eq_true _ _).mp guard
    simp only [beq_iff_eq] at target source
    refine ⟨by unfold MergeParents.ordered; rw [target, source], ?_⟩
    intro same
    exact parents.distinct (by rw [target, source, same])
  · rw [if_neg guard] at admitted
    simp [refuse] at admitted

/-- **An admitted merge satisfies the model's equal-pin half of `CurrentMergeHeads`.** The
model asks that both parents' pins equal the commit's; `admitMergePins` is exactly that
question, and its answer carries over under any pin bridge. -/
theorem admitMergePins_refines_model {target source commit : RunPins} (idOf : String → Nat)
    (admitted : admitMergePins target source commit = .ok ()) :
    target.toModel idOf = commit.toModel idOf ∧ source.toModel idOf = commit.toModel idOf := by
  obtain ⟨same, carried⟩ := admitMergePins_agrees admitted
  rw [carried, same]
  exact ⟨rfl, rfl⟩

end AgentCore.Kernel
