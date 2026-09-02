import SpecCnl.Unit

/-!
# RunGraph: reviewed pairings for §5.2

The §5.2 rule units about the commit graph itself: what a Run's graph is closed over, what
an `undo` does to a branch, what a merge's two parents are, and the three derivations the
document builds on top of ancestry — the effective transcript, a rewrite's bracket, and a
cut's balance. The model has the graph and the undo selection; it does not have the
rewrite plane at all, and that asymmetry is what this group's records mostly report.

Three weaknesses run through the group.

* **The append label's payload is one commit, and only one.** `AgentCore.GraphLabel.append`
  carries the new `CommitId`, the expected head, and the `RunCommit`, and the corpus's
  lifter scopes a condition under the commit. Any clause naming the *new head* or the
  *prior head* — "the branch head advances to `U`", "prior heads remain reachable" — cannot
  be formed at all, and is dropped on the record with the model theorem that proves it.
* **A sequence of two appends is not a sentence.** Redo is an undo commit appended after
  another undo commit, and the controlled language quantifies over one transition. The
  round trip stays in `AgentCore.undo_then_redo_restores_effective_state`.
* **Three units of this group are not bridged, for the same absence.** `AgentCore` has no
  rewrite `RunCommitKind`, no `shadows` field on `RunCommit`, and no transcript function,
  so `C13-RUN-EFFECTIVE-TRANSCRIPT`, `C13-RUN-REWRITE-BRACKET` and `C13-RUN-CUT-BALANCE`
  have no relation of the model to bridge to. Their one model-true clause — nothing is
  deleted — is `C13-RUN-UNDO-REDO`'s own leading MUST and is carried there, so restating it
  under a rewrite atom would claim a bridge for a clause that atom does not own.
-/

namespace SpecCnl.Corpus.Units.RunGraph

def units : List RuleUnit :=
  [ { key := "C13_RUN_GRAPH_CLOSED"
      atoms := ["C13-RUN-GRAPH-CLOSED"]
      specSection := "5.2"
      anchor := "SPEC.md:1683"
      digest := "28323b22d00cd1344a0e3ee4d602a061dc8f6e1409053c8ee0bbd2ac65457f28"
      sentence :=
        "every graph append requires same run parents for the appended commit and every \
         graph append requires an owned branch for the appended commit and additionally \
         every graph spawn establishes an unparented child root for the spawn"
      dropped :=
        [ "'Every RunCommit names the Run it belongs to': AgentCore.RunCommit.run is a \
           field, so a rendering of that clause would be true by construction and \
           therefore vacuous",
          "'whose source MUST be a distinct branch of that same Run rather than whichever \
           branch happens to stand at the named head': C13-RUN-DISTINCTION-REPRESENTABLE \
           carries the distinct-branch, distinct-head half over the same \
           AgentCore.CurrentMergeHeads premise, so this record does not claim it twice",
          "the derivations closure is said to protect. Effective state exists as \
           AgentCore.GraphStore.effectiveState, but the model has no rewrite commit kind, \
           no shadow set and no transcript function, so the effective transcript, a cut's \
           balance, and the ancestors a rewrite may shadow have nothing to range over — \
           see the unbridged C13-RUN-EFFECTIVE-TRANSCRIPT and C13-RUN-CUT-BALANCE",
          "'A wallClockMs remainder ... measures from the Run's root RunCommit': \
           AgentCore.RunCommit carries no timestamp and the model measures no elapsed \
           time, so the second-candidate-origin argument has nothing to range over",
          "the sentence quantifies over the append family and the spawn family. \
           AgentCore.GraphLabel.migrate writes a commit too, and \
           AgentCore.migration_requires_fresh_commit_on_owned_branch is where the same \
           branch-ownership premise for that path lives",
          "'whatever the parent hands it — a task statement, an excerpt of the parent's \
           transcript, a digest — arrives as the content of a commit the child appended \
           under the child's own writer evidence': AgentCore.RunCommit carries no content, \
           so the handover has nothing to range over and the third clause carries only the \
           zero-parent root that makes the child's ancestry its own",
          "the closing counterfactual, that a platform seeding a child by replaying the \
           parent's commits would owe every child a durable watermark: a claim about a \
           design this document refuses rather than a property of the model" ] },
    { key := "C13_RUN_DISTINCTION_REPRESENTABLE"
      atoms := ["C13-RUN-DISTINCTION-REPRESENTABLE"]
      specSection := "5.2"
      anchor := "SPEC.md:1622"
      digest := "b0e641897d6fa672856d4446e671c2917d4ff3f480f06eb0b2c651475718b941"
      sentence :=
        "every merge append requires distinct named heads for the appended commit and \
         every merge append requires equal pinned parents for the appended commit"
      dropped :=
        [ "'a merge's parents are two distinct lineages and no value naming one commit \
           twice is constructable'. THE SENTENCE IS WEAKER THAN THE ATOM. \
           AgentCore.RunCommit.parents is a plain List CommitId, so the illegal value the \
           atom wants unrepresentable is representable here too, and the absence of a type \
           that refuses a repeated parent is a signature-level negative that is not \
           statable inside the theory. What the sentence carries is the runtime comparison \
           the atom concedes is correct today: AgentCore.CurrentMergeHeads is a premise of \
           the merge append, so the value is refused before it lands rather than never \
           built",
          "'a model input's coverage statement (§5.6) attributes each omission to the \
           commit whose content it withheld': the model has no model input, no coverage \
           list and no abridgement, so the second half of the atom's shared rule has \
           nothing to range over",
          "'survives its codec': the model has no codec, so nothing distinguishes a value \
           that round-trips from one that does not",
          "'Neither case makes a wrong answer reachable ... what is missing is resolution \
           rather than correctness': an argument about the specification's own design \
           economy rather than a property of a transition",
          "the parent count, which C13-RUN-GRAPH-ARITY and C13-RUN-BINARY-TREE-MERGE \
           carry. The first clause names the parent list to say the two named heads are \
           distinct and are the current heads of two distinct branches; the arity it \
           mentions in passing is those two units' clause and not this one's",
          "the second clause bounds the pins of the parents the graph actually stores. A \
           merge naming a parent the store does not hold is refused by \
           AgentCore.ParentsClosed under C13-RUN-GRAPH-CLOSED rather than by this \
           sentence" ] },
    { key := "C13_RUN_UNDO_REDO"
      atoms := ["C13-RUN-UNDO-REDO"]
      specSection := "5.2"
      anchor := "SPEC.md:1587"
      digest := "edcb4108d312d6a553e83848b2b127e79ae29dd50eee4b784674d6adb6a0c19b"
      sentence :=
        "every graph step maintains stored commits and every undo append establishes a \
         selected effective state for the appended commit"
      dropped :=
        [ "'Redo appends another undo commit selecting the prior effective commit': redo \
           is a second append, and the grammar has no form for a sentence about two steps \
           in sequence. AgentCore.undo_then_redo_restores_effective_state is where the \
           round trip lives, and it is what shows the pending revert is reversible",
          "'the branch head advances to U': the new head is the CommitId the append label \
           carries, and the appended-commit lifter scopes a postcondition under the commit \
           alone, so no condition of this vocabulary can name it. \
           AgentCore.undo_selects_effective_state proves the head advance beside the \
           effective-state half the sentence carries",
          "'Prior heads remain reachable; ancestry queries are unaffected': the prior head \
           is the label's expected CommitId, unreachable for the same reason. \
           AgentCore.undo_keeps_prior_head_reachable proves that both the displaced head \
           and the selected commit stay ancestors of the new head, and C13-RUN-ANCESTRY \
           carries the ancestry-depends-only-on-the-commits half",
          "'The interval until the next non-undo commit is the pending revert: it is \
           durable and reversible': the model has no interval between commits and no \
           pending-revert record, so durability has nothing to range over",
          "'whose parent is the current head and whose selects field names an ancestor \
           commit': C13-RUN-UNDO-FENCE carries the ancestor-selection premise, and the \
           parent-is-the-expected-head shape is the append constructor's own arity \
           condition rather than a clause this sentence adds",
          "the first clause is stronger than append-only for undo alone — no transition of \
           any label removes or rewrites a stored commit — and weaker than append-only for \
           the whole graph, because AgentCore.GraphStore.heads does move and the sentence \
           says nothing about parent order" ] } ]

end SpecCnl.Corpus.Units.RunGraph
