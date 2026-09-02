import SpecCnl.Unit

/-!
# ModelInput: reviewed pairings for §5.6

§5.6 is about the record of a model call: the request as the model observed it, the
records it must be reconstructable from, what a reconstruction owes when the content it
names is gone, how much of a result the model was actually shown, and which transcript
commits a surface carries. **Five of this group's six rule units are not bridged, and the
absence is the same one every time**: `AgentCore.RunCommitKind` has no `modelInput`
constructor and no `rewrite` constructor, `AgentCore.RunCommit` carries no content and no
`shadows` field, and the model has no prompt section, no operation catalog, no coverage
statement, no abridgement, no transcript function, and no model-call transition. There is
nothing for a reconstruction, a dispatch ordering, an omission fact, or a compacted
surface to range over, so a sentence about any of them would quantify over a family the
model does not have. Those five are reported in the result rather than rendered here; the
landed `RunGraph` group reports the same absence for `C13-RUN-EFFECTIVE-TRANSCRIPT`,
`C13-RUN-REWRITE-BRACKET`, and `C13-RUN-CUT-BALANCE`, and its own record already carries
the one model-true clause of the rewrite plane — no transition deletes a stored commit —
under `C13-RUN-UNDO-REDO`, so restating it under a §5.6 atom would claim a bridge for a
clause that atom does not own.

The one unit that reaches the model reaches it through the content-retention plane, and
only through the half of `C13-TURN-MODEL-INPUT-RETENTION-LOSS` that is about a
`ContentRef` rather than about a reconstruction. §8.2's ledger already carries two
disjoint clauses in this corpus — the tenant gate on resolution
(`C13-CONTENT-RESOLUTION`) and retention safety once registered
(`C13-CONTENT-CUSTODY`) — and this record's clause is the third: content the ledger no
longer stores admits no resolution at all, so the seam a reconstruction would read
refuses rather than returning a shorter or best-effort value. That is one clause of one
sentence of a rule unit whose subject the model does not have, and the record below says
so in capitals.
-/

namespace SpecCnl.Corpus.Units.ModelInput

def units : List RuleUnit :=
  [ { key := "C13_TURN_MODEL_INPUT_RETENTION_LOSS"
      atoms := ["C13-TURN-MODEL-INPUT-RETENTION-LOSS"]
      specSection := "5.6"
      anchor := "SPEC.md:2123"
      digest := "3b3b7552d6f5d0d1e4c8da546982b08b385ce2cda47ea9d86f5e754ad6607c19"
      sentence := "every content resolve requires retained content for the resolved reference"
      dropped :=
        [ "'A reconstruction that finds a named Event or ContentRef no longer retained \
           MUST fail with a typed error naming what is missing, and MUST NOT assemble a \
           shorter prefix, a partial request, or a best-effort approximation'. THE \
           SENTENCE IS WEAKER THAN THE ATOM. The model has no reconstruction, no model \
           input and no typed failure kind — AgentCore.RunCommitKind has no modelInput \
           constructor and AgentCore.RunCommit carries no content — so a request being \
           rebuilt has nothing to range over. What the sentence carries is the one seam \
           the model does have — resolving a ContentRef the ledger no longer stores is \
           refused rather than approximated, so no shorter or best-effort value is \
           reachable through it",
          "'a named Event ... no longer retained': AgentCore.EventLabel is publish, \
           reserve, project and deliver, with no deletion or expiry step and no retention \
           field on an Event, so an unretained Event is unrepresentable and the sentence \
           carries the ContentRef half alone",
          "'Content a request names is retained by the records naming it (§8.2)': the \
           coverage half of §8.2 — naming implies owning — is explicitly outside the \
           model, as the AgentCore.Content module boundary states and \
           C13-CONTENT-CUSTODY's own record reports, because \
           AgentCore.ContentLedger.owningRecords is populated only by an explicit own \
           step",
          "'Tenant-level retention policy — export, legal deletion, Tenant closure — \
           legitimately ends retention': the model has no retention policy, no export and \
           no Tenant closure. The one way stored content stops being stored is \
           AgentCore.ContentLabel.collect, whose unowned premise C13-CONTENT-CUSTODY \
           carries, so the sentence says when a resolution is admitted and never why the \
           content went away",
          "'Losing content is legitimate; losing it silently is not', and the argument \
           that a reconstruction quietly yielding a different request is worse than one \
           that refuses because the byte-compare would then compare two wrong values and \
           pass: a claim about what makes the rule testable rather than a property of a \
           transition",
          "the two clauses the same ledger already carries are deliberately not restated: \
           C13-CONTENT-RESOLUTION carries the home-or-granted tenant gate over this same \
           resolve family, and C13-CONTENT-CUSTODY carries owned-implies-stored \
           preservation together with the collect premise. This record's clause is the \
           third and disjoint one — retention is a precondition of resolving at all — and \
           the sentence's condition reads AgentCore.ContentLedger.stored and nothing \
           else" ] } ]

end SpecCnl.Corpus.Units.ModelInput
