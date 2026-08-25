import SpecCnl.Grammar
import SpecCnl.Parse

/-!
# The lexicon

The closed vocabulary of the controlled language, and the only place a surface form is
bound to a meaning. Each entry carries a category and a Lean denotation as reviewed
source text; the elaborator ascribes the denotation the type its category interprets to,
so an entry whose meaning does not inhabit its declared category is a Lean type error
rather than a comment nobody checks.

Two rules govern what may appear here.

1. **Every entry is exercised by the corpus.** An unexercised paradigm cell is not
   shipped. `lexiconRefusals` and the gate both enforce this, so the reported grammar is
   the demonstrated grammar.
2. **A weakening is declared, not implied.** `Caveat.typeAsCommonNoun` marks an entry
   whose denotation is `fun _ => True`, and so cannot refuse a wrong noun.
   No entry recovers a transition parameter by matching a label inside its own
   denotation. Where a condition is about a transition's payload rather than its label,
   the payload condition and the label match are separate entries — a condition over the
   payload and a lifting entry that scopes it under one label constructor — so the two
   are reviewed apart and the lifter is reused across every unit about that constructor.
3. **A transition family carries its own quantifier.** Every connective over `TR` is
   universal in the family, so a `TR` surface reads `every ...` rather than `a ...`.
   Writing `a merge append requires ...` would read as existential and mean universal.

Grammar entries carry no domain content. Content entries denote terms over `AgentCore`
alone; nothing here introduces a constant of its own.
-/

namespace SpecCnl

/-! ## Grammar entries -/

private def grammarEntries : List LexEntry :=
  [ { id := "every"
      surface := "every"
      category := "(S/(NP[a]\\S))/CN[a]"
      denotation := "SpecCnl.qEvery" },
    { id := "some.object"
      surface := "some"
      category := "(((NP[a]\\S)/NP[t])\\(NP[a]\\S))/CN[t]"
      denotation := "SpecCnl.qSomeObj" },
    { id := "no.object"
      surface := "no"
      category := "(((NP[a]\\S)/NP[t])\\(NP[a]\\S))/CN[t]"
      denotation := "SpecCnl.qNoObj" },
    { id := "requires"
      surface := "requires"
      category := "(TR[s,l]\\S)/ST[s,l]"
      denotation := "SpecCnl.trRequires" },
    { id := "holds.before"
      surface := "holds before"
      category := "(ST[s,l]\\S)/TR[s,l]"
      denotation := "SpecCnl.stHoldsBefore" },
    { id := "preserves"
      surface := "preserves"
      category := "(TR[s,l]\\S)/CN[s]"
      denotation := "SpecCnl.trPreserves" },
    { id := "maintains"
      surface := "maintains"
      category := "(TR[s,l]\\S)/PR[s]"
      denotation := "SpecCnl.trMaintains" },
    { id := "and.sentence"
      surface := "and"
      category := "(S\\S)/S"
      denotation := "SpecCnl.sAnd" },
    { id := "or.relation"
      surface := "or"
      category := "(RE[s,k,v]\\RE[s,k,v])/RE[s,k,v]"
      denotation := "SpecCnl.reOr" },
    { id := "is.at.most"
      surface := "is at most"
      category := "(NU[s,p]\\ST[s,p])/NU[s,p]"
      denotation := "SpecCnl.nuAtMost" },
    { id := "equals"
      surface := "equals"
      category := "(NU[s,p]\\ST[s,p])/NU[s,p]"
      denotation := "SpecCnl.nuEquals" },
    { id := "depends.only.on"
      surface := "depends only on"
      category := "(RE[s,k,v]\\S)/NP[f]"
      denotation := "SpecCnl.reDependsOnlyOn" },
    { id := "assigns.at.most.one.value"
      surface := "assigns at most one value"
      category := "RE[s,k,v]\\S"
      denotation := "SpecCnl.reAtMostOneValue" },
    { id := "two"
      surface := "two"
      category := "NU[s,p]"
      denotation := "SpecCnl.nuLiteral 2" } ]

/-! ## Content entries

### The run graph -/

private def runGraphEntries : List LexEntry :=
  [ { id := "ancestry"
      surface := "ancestry"
      category := "RE[AgentCore.GraphStore,AgentCore.CommitId,AgentCore.CommitId]"
      denotation := "AgentCore.Ancestor" },
    { id := "the.commits"
      surface := "the commits"
      category := "NP[SpecCnl.CommitTable]"
      denotation := "AgentCore.GraphStore.commits" },
    { id := "the.head.tree"
      surface := "the head tree"
      category := "RE[AgentCore.GraphStore,AgentCore.RunId,AgentCore.TreeId]"
      denotation := "AgentCore.GraphStore.HeadTree" },
    { id := "every.merge.append"
      surface := "every merge append"
      category := "TR[AgentCore.GraphStore,AgentCore.GraphLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ id expected commit conversation tree, " ++
        "label = AgentCore.GraphLabel.append id expected commit ∧ " ++
        "AgentCore.RunCommit.kind commit = AgentCore.RunCommitKind.merge conversation tree) ∧ " ++
        "∃ effects events audit, " ++
        "AgentCore.GraphStep effects events audit before label after" },
    { id := "every.undo.append"
      surface := "every undo append"
      category := "TR[AgentCore.GraphStore,AgentCore.GraphLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ id expected commit selected receipt, " ++
        "label = AgentCore.GraphLabel.append id expected commit ∧ " ++
        "AgentCore.RunCommit.kind commit = AgentCore.RunCommitKind.undo selected receipt) ∧ " ++
        "∃ effects events audit, " ++
        "AgentCore.GraphStep effects events audit before label after" },
    { id := "for.the.appended.commit"
      surface := "for the appended commit"
      category :=
        "ST[AgentCore.GraphStore,AgentCore.RunCommit]\\ST[AgentCore.GraphStore,AgentCore.GraphLabel]"
      denotation :=
        "fun cond before label => ∀ id expected commit, " ++
        "label = AgentCore.GraphLabel.append id expected commit → cond before commit" },
    { id := "the.parent.count"
      surface := "the parent count"
      category := "NU[AgentCore.GraphStore,AgentCore.RunCommit]"
      denotation := "fun _ commit => List.length (AgentCore.RunCommit.parents commit)" },
    { id := "an.unheld.branch"
      surface := "an unheld branch"
      category := "ST[AgentCore.GraphStore,AgentCore.RunCommit]"
      denotation :=
        "fun store commit => AgentCore.BranchUnheld store " ++
        "(AgentCore.RunCommit.run commit) (AgentCore.RunCommit.branch commit)" },
    { id := "a.selected.ancestor"
      surface := "a selected ancestor"
      category := "ST[AgentCore.GraphStore,AgentCore.RunCommit]"
      denotation :=
        "fun store commit => ∀ selected receipt, " ++
        "AgentCore.RunCommit.kind commit = AgentCore.RunCommitKind.undo selected receipt → " ++
        "∃ parent, parent ∈ AgentCore.RunCommit.parents commit ∧ " ++
        "AgentCore.Ancestor store selected parent" } ]

/-! ### Turn leases -/

private def leaseEntries : List LexEntry :=
  [ { id := "every.lease.reclaim"
      surface := "every lease reclaim"
      category := "TR[AgentCore.TurnLease,AgentCore.LeaseLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ holder now expiresAt, " ++
        "label = AgentCore.LeaseLabel.reclaim holder now expiresAt) ∧ " ++
        "AgentCore.LeaseStep before label after" },
    { id := "for.the.reclaim"
      surface := "for the reclaim"
      category :=
        "ST[AgentCore.TurnLease,AgentCore.Time]\\ST[AgentCore.TurnLease,AgentCore.LeaseLabel]"
      denotation :=
        "fun cond before label => ∀ holder now expiresAt, " ++
        "label = AgentCore.LeaseLabel.reclaim holder now expiresAt → cond before now" },
    { id := "the.recorded.expiry"
      surface := "the recorded expiry"
      category := "NU[AgentCore.TurnLease,AgentCore.Time]"
      denotation :=
        "fun lease _ => AgentCore.Time.tick (AgentCore.TurnLease.expiresAt lease)" },
    { id := "the.stated.time"
      surface := "the stated time"
      category := "NU[AgentCore.TurnLease,AgentCore.Time]"
      denotation := "fun _ now => AgentCore.Time.tick now" } ]

/-! ### Effects and receipts -/

private def effectEntries : List LexEntry :=
  [ { id := "every.effect.step"
      surface := "every effect step"
      category := "TR[AgentCore.EffectLedger,AgentCore.EffectLabel]"
      denotation := "AgentCore.EffectStep" },
    { id := "attempt.immutability"
      surface := "attempt immutability"
      category := "PR[AgentCore.EffectLedger]"
      denotation :=
        "fun before after => ∀ id attempt, " ++
        "AgentCore.EffectLedger.attempts before id = some attempt → " ++
        "AgentCore.EffectLedger.attempts after id = some attempt" },
    { id := "disjoint.receipt.ids"
      surface := "disjoint receipt ids"
      category := "CN[AgentCore.EffectLedger]"
      denotation := "AgentCore.ReceiptIdsDisjoint" } ]

/-! ### Events and trust -/

private def eventEntries : List LexEntry :=
  [ { id := "tier.predicate"
      surface := "tier predicate"
      category := "CN[SpecCnl.TierPredicate]"
      denotation := "fun _ => True"
      caveats := [.typeAsCommonNoun] },
    { id := "subscription"
      surface := "subscription"
      category := "CN[AgentCore.RoutedSubscription]"
      denotation := "fun _ => True"
      caveats := [.typeAsCommonNoun] },
    { id := "is.the.accepted.set.of"
      surface := "is the accepted set of"
      category :=
        "(NP[SpecCnl.TierPredicate]\\S)/NP[AgentCore.RoutedSubscription]"
      denotation :=
        "fun subscription predicate => " ++
        "AgentCore.RoutedSubscription.admits subscription = predicate" },
    { id := "published.event"
      surface := "published event"
      category := "CN[AgentCore.Event]"
      denotation :=
        "fun event => ∃ leases now before after id, " ++
        "AgentCore.EventStep leases now before (AgentCore.EventLabel.publish id) after ∧ " ++
        "AgentCore.EventStore.events after id = some event" },
    { id := "asserted.tier"
      surface := "asserted tier"
      category := "CN[AgentCore.TrustTier]"
      denotation := "fun _ => True"
      caveats := [.typeAsCommonNoun] },
    { id := "has.asserted.tier"
      surface := "has"
      category := "(NP[AgentCore.Event]\\S)/NP[AgentCore.TrustTier]"
      denotation := "fun tier event => AgentCore.Event.assertedTier event = some tier" } ]

/-! ### Authority and content -/

private def authorityEntries : List LexEntry :=
  [ { id := "every.role.materialization"
      surface := "every role materialization"
      category := "TR[AgentCore.AuthorityLedger,AgentCore.Membership]"
      denotation :=
        "fun before membership after => ∃ role, " ++
        "AgentCore.MaterializationStep before membership role after" },
    { id := "a.verified.guest.subject"
      surface := "a verified guest subject"
      category := "ST[AgentCore.AuthorityLedger,AgentCore.Membership]"
      denotation :=
        "fun before membership => ∀ home principal scheme, " ++
        "AgentCore.Membership.subject membership = " ++
        "AgentCore.Subject.foreign home principal scheme → " ++
        "AgentCore.AuthorityLedger.foreignVerified before home principal" },
    { id := "every.content.resolve"
      surface := "every content resolve"
      category := "TR[AgentCore.ContentLedger,AgentCore.ContentLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ ref requester, label = AgentCore.ContentLabel.resolve ref requester) ∧ " ++
        "AgentCore.ContentStep before label after" },
    { id := "for.the.resolved.reference"
      surface := "for the resolved reference"
      category :=
        "RE[AgentCore.ContentLedger,AgentCore.ContentRef,AgentCore.TenantId]" ++
        "\\ST[AgentCore.ContentLedger,AgentCore.ContentLabel]"
      denotation :=
        "fun cond before label => ∀ ref requester, " ++
        "label = AgentCore.ContentLabel.resolve ref requester → cond before ref requester" },
    { id := "a.home.tenant"
      surface := "a home tenant"
      category := "RE[AgentCore.ContentLedger,AgentCore.ContentRef,AgentCore.TenantId]"
      denotation := "fun _ ref requester => requester = AgentCore.ContentRef.tenant ref" },
    { id := "a.granted.tenant"
      surface := "a granted tenant"
      category := "RE[AgentCore.ContentLedger,AgentCore.ContentRef,AgentCore.TenantId]"
      denotation :=
        "fun ledger ref requester => " ++
        "AgentCore.ContentLedger.crossTenantGrants ledger requester ref" } ]

/-- The whole lexicon. Order is reviewed and stable: the emitted ledger reports entries
in this order, so a reordering is a visible diff. -/
def lexicon : List LexEntry :=
  grammarEntries ++ runGraphEntries ++ leaseEntries ++ effectEntries ++ eventEntries ++
    authorityEntries

/-- An entry id may use lowercase letters, digits, and dots, and must start with a
letter.

This is not cosmetic. `Item.key` identifies a reading by writing its head ids into a
nested `head(arg,arg)` string, and distinct readings are counted by distinct keys. An id
carrying `(`, `,` or `)` could make two genuinely different readings produce the same key,
which would report an ambiguous sentence as having one reading — the exact failure the
grammar exists to prevent. The charset keeps the key injective. -/
def isSafeEntryId (id : String) : Bool :=
  match id.toList with
  | [] => false
  | head :: rest =>
      head.isLower &&
        rest.all (fun c => (c.isLower && c.isAlpha) || c.isDigit || c == '.')

/-- Structural refusals of the lexicon itself, independent of any sentence: an unsafe id,
a duplicate id, a duplicate (surface, category) pair, or a category that does not read. A
duplicate surface with the *same* category would make one reading appear twice and mask a
genuine ambiguity, so it is refused here rather than reported later. -/
def lexiconRefusals : List String := Id.run do
  let mut refusals : List String := []
  let mut ids : List String := []
  let mut shapes : List String := []
  for entry in lexicon do
    if !isSafeEntryId entry.id then
      refusals := refusals ++
        [s!"lexicon entry id '{entry.id}' is outside the safe charset; a reading key \
            built from it would not be injective"]
    if ids.contains entry.id then
      refusals := refusals ++ [s!"duplicate lexicon entry id '{entry.id}'"]
    ids := entry.id :: ids
    let shape := s!"{entry.surface}::{entry.category}"
    if shapes.contains shape then
      refusals := refusals ++
        [s!"lexicon entries '{entry.id}' and an earlier entry share surface and category"]
    shapes := shape :: shapes
    match Cat.ofString entry.category with
    | .error message =>
        refusals := refusals ++ [s!"lexicon entry '{entry.id}' category: {message}"]
    | .ok category =>
        if category.render.replace " " "" != s!"({entry.category})".replace " " ""
            && category.render.replace " " "" != entry.category.replace " " "" then
          refusals := refusals ++
            [s!"lexicon entry '{entry.id}' category does not round-trip: " ++
              s!"'{entry.category}' reads back as '{category.render}'"]
  return refusals

end SpecCnl
