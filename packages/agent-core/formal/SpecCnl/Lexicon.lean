import SpecCnl.Entries.Auth
import SpecCnl.Entries.Commands
import SpecCnl.Entries.FacetInstall
import SpecCnl.Entries.Isolate
import SpecCnl.Entries.Placement
import SpecCnl.Entries.RunGraph
import SpecCnl.Grammar
import SpecCnl.Parse

/-!
# The lexicon

The closed vocabulary of the controlled language, and the only place a surface form is
bound to a meaning. Each entry carries a category and a Lean denotation as reviewed
source text; the elaborator ascribes the denotation the type its category interprets to,
so an entry whose meaning does not inhabit its declared category is a Lean type error
rather than a comment nobody checks.

Four rules govern what may appear here.

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
4. **A content section is a paradigm, not a list of phrases.** One ledger contributes one
   `TR` entry per label family the corpus quantifies over, one lifting entry per label
   constructor whose payload a condition reads, and then the payload conditions
   themselves. The lifter and the family entry are shared by every unit about that
   ledger, which is why adding a second rule about an already-modelled ledger costs one
   condition rather than a fresh paradigm.

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
    { id := "establishes"
      surface := "establishes"
      category := "(TR[s,l]\\S)/PO[s,l]"
      denotation := "SpecCnl.trEstablishes" },
    { id := "and.sentence"
      surface := "and"
      category := "(S\\S)/S"
      denotation := "SpecCnl.sAnd" },
    { id := "and.pair"
      surface := "and"
      category := "(S\\CJ)/S"
      denotation := "SpecCnl.sPair" },
    { id := "and.additionally"
      surface := "and additionally"
      category := "(CJ\\S)/S"
      denotation := "SpecCnl.sAdditionally" },
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
      denotation := "SpecCnl.nuLiteral 2" },
    { id := "is.transitive"
      surface := "is transitive"
      category := "PR[a]\\S"
      denotation := "SpecCnl.prTransitive" },
    { id := "is.antisymmetric"
      surface := "is antisymmetric"
      category := "PR[a]\\S"
      denotation := "SpecCnl.prAntisymmetric" },
    { id := "is.irreflexive"
      surface := "is irreflexive"
      category := "PR[a]\\S"
      denotation := "SpecCnl.prIrreflexive" } ]

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

/-! ### Secret custody -/

private def secretEntries : List LexEntry :=
  [ { id := "every.secret.step"
      surface := "every secret step"
      category := "TR[AgentCore.SecretLedger,AgentCore.SecretLabel]"
      denotation := "AgentCore.SecretStep" },
    { id := "carrier.refs.only"
      surface := "carrier refs only"
      category := "CN[AgentCore.SecretLedger]"
      denotation := "AgentCore.CarrierRefOnly" },
    { id := "every.secret.resolve"
      surface := "every secret resolve"
      category := "TR[AgentCore.SecretLedger,AgentCore.SecretLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ id secret requester binding endpoint, " ++
        "label = AgentCore.SecretLabel.resolve id secret requester binding endpoint) ∧ " ++
        "AgentCore.SecretStep before label after" },
    { id := "for.the.resolved.secret"
      surface := "for the resolved secret"
      category :=
        "RE[AgentCore.SecretLedger,AgentCore.SecretRef,AgentCore.TenantId]" ++
        "\\ST[AgentCore.SecretLedger,AgentCore.SecretLabel]"
      denotation :=
        "fun cond before label => ∀ id secret requester binding endpoint, " ++
        "label = AgentCore.SecretLabel.resolve id secret requester binding endpoint → " ++
        "cond before secret requester" },
    { id := "a.home.tenant.consumer"
      surface := "a home tenant consumer"
      category := "RE[AgentCore.SecretLedger,AgentCore.SecretRef,AgentCore.TenantId]"
      denotation :=
        "fun _ secret requester => requester = AgentCore.SecretRef.source secret" } ]

/-! ### Content retention -/

private def contentRetentionEntries : List LexEntry :=
  [ { id := "every.content.step"
      surface := "every content step"
      category := "TR[AgentCore.ContentLedger,AgentCore.ContentLabel]"
      denotation := "AgentCore.ContentStep" },
    { id := "owned.content.stored"
      surface := "owned content stored"
      category := "CN[AgentCore.ContentLedger]"
      denotation := "AgentCore.OwnedImpliesStored" },
    { id := "every.content.collect"
      surface := "every content collect"
      category := "TR[AgentCore.ContentLedger,AgentCore.ContentLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ ref, label = AgentCore.ContentLabel.collect ref) ∧ " ++
        "AgentCore.ContentStep before label after" },
    { id := "for.the.collected.content"
      surface := "for the collected content"
      category :=
        "ST[AgentCore.ContentLedger,AgentCore.ContentRef]" ++
        "\\ST[AgentCore.ContentLedger,AgentCore.ContentLabel]"
      denotation :=
        "fun cond before label => ∀ ref, " ++
        "label = AgentCore.ContentLabel.collect ref → cond before ref" },
    { id := "an.unowned.reference"
      surface := "an unowned reference"
      category := "ST[AgentCore.ContentLedger,AgentCore.ContentRef]"
      denotation :=
        "fun ledger ref => ∀ record, " ++
        "¬ AgentCore.ContentLedger.owningRecords ledger ref record" } ]

/-! ### The Scope chain -/

private def scopeEntries : List LexEntry :=
  [ { id := "scope.reach"
      surface := "scope reach"
      category := "PR[AgentCore.Scope]"
      denotation := "AgentCore.ScopeReaches" } ]

/-! ### The audit log -/

private def auditEntries : List LexEntry :=
  [ { id := "every.audit.step"
      surface := "every audit step"
      category := "TR[AgentCore.AuditLog,AgentCore.AuditLabel]"
      denotation :=
        "fun before label after => ∃ effects events, " ++
        "AgentCore.AuditStep effects events before label after" },
    { id := "recorded.entry.immutability"
      surface := "recorded entry immutability"
      category := "PR[AgentCore.AuditLog]"
      denotation :=
        "fun before after => ∀ id entry, " ++
        "AgentCore.AuditLog.entries before id = some entry → " ++
        "AgentCore.AuditLog.entries after id = some entry" },
    { id := "a.typed.lower.local.cause"
      surface := "a typed lower local cause"
      category := "PR[AgentCore.AuditLog]"
      denotation :=
        "fun before after => ∃ id entry, " ++
        "AgentCore.AuditLog.entries after id = some entry ∧ " ++
        "∀ cause, AgentCore.AuditEntry.cause entry = some cause → " ++
        "∃ parent, AgentCore.AuditLog.entries before cause = some parent ∧ " ++
        "AgentCore.AuditEntry.actor parent = AgentCore.AuditEntry.actor entry ∧ " ++
        "AgentCore.AuditEntry.sequence parent < AgentCore.AuditEntry.sequence entry ∧ " ++
        "AgentCore.AuditEntry.correlation parent = AgentCore.AuditEntry.correlation entry ∧ " ++
        "AgentCore.MayCause (AgentCore.AuditEntry.kind parent) " ++
        "(AgentCore.AuditEntry.kind entry)" } ]

/-! ### Event routing -/

private def routingEntries : List LexEntry :=
  [ { id := "every.routing.step"
      surface := "every routing step"
      category := "TR[AgentCore.SubscriptionLedger,AgentCore.RoutingLabel]"
      denotation := "AgentCore.RoutingStep" },
    { id := "consumed.key.persistence"
      surface := "consumed key persistence"
      category := "PR[AgentCore.SubscriptionLedger]"
      denotation :=
        "fun before after => ∀ subscription key, " ++
        "AgentCore.SubscriptionLedger.consumed before subscription key → " ++
        "AgentCore.SubscriptionLedger.consumed after subscription key" },
    { id := "every.subscription.firing"
      surface := "every subscription firing"
      category := "TR[AgentCore.SubscriptionLedger,AgentCore.RoutingLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ subscription event target, " ++
        "label = AgentCore.RoutingLabel.fire subscription event target) ∧ " ++
        "AgentCore.RoutingStep before label after" },
    { id := "for.the.firing"
      surface := "for the firing"
      category :=
        "RE[AgentCore.SubscriptionLedger,AgentCore.SubscriptionId,AgentCore.EventId]" ++
        "\\ST[AgentCore.SubscriptionLedger,AgentCore.RoutingLabel]"
      denotation :=
        "fun cond before label => ∀ subscription event target, " ++
        "label = AgentCore.RoutingLabel.fire subscription event target → " ++
        "cond before subscription event" },
    { id := "an.unconsumed.event.key"
      surface := "an unconsumed event key"
      category :=
        "RE[AgentCore.SubscriptionLedger,AgentCore.SubscriptionId,AgentCore.EventId]"
      denotation :=
        "fun ledger subscription event => ∀ record, " ++
        "AgentCore.SubscriptionLedger.events ledger event = some record → " ++
        "¬ AgentCore.SubscriptionLedger.consumed ledger subscription " ++
        "(AgentCore.RoutedEvent.key record)" } ]

/-! ### Approval identity -/

private def approvalEntries : List LexEntry :=
  [ { id := "approval.mapping"
      surface := "approval mapping"
      category :=
        "RE[AgentCore.ApprovalLedger,AgentCore.InvocationId,AgentCore.ApprovalId]"
      denotation :=
        "fun ledger invocation approval => " ++
        "AgentCore.ApprovalLedger.approvalFor ledger invocation = some approval" } ]

/-! ### Duplicate submissions -/

private def submissionEntries : List LexEntry :=
  [ { id := "every.duplicate.submission"
      surface := "every duplicate submission"
      category := "TR[AgentCore.SubmissionLedger,AgentCore.SubmissionLabel]"
      denotation :=
        "fun before label after => (∃ id, label = AgentCore.SubmissionLabel.resubmit id) ∧ " ++
        "AgentCore.SubmissionStep before label after" },
    { id := "reservation.and.event.identity"
      surface := "reservation and event identity"
      category := "PR[AgentCore.SubmissionLedger]"
      denotation :=
        "fun before after => " ++
        "AgentCore.SubmissionLedger.reserved after = " ++
        "AgentCore.SubmissionLedger.reserved before ∧ " ++
        "AgentCore.SubmissionLedger.invoked after = " ++
        "AgentCore.SubmissionLedger.invoked before" },
    { id := "for.the.duplicate"
      surface := "for the duplicate"
      category :=
        "PX[AgentCore.SubmissionLedger,AgentCore.SubmissionWriteId]" ++
        "\\PO[AgentCore.SubmissionLedger,AgentCore.SubmissionLabel]"
      denotation :=
        "fun cond before label after => ∀ id, " ++
        "label = AgentCore.SubmissionLabel.resubmit id → cond before id after" },
    { id := "a.recorded.original.reply"
      surface := "a recorded original reply"
      category := "PX[AgentCore.SubmissionLedger,AgentCore.SubmissionWriteId]"
      denotation :=
        "fun before id after => ∃ write originalId original, " ++
        "AgentCore.SubmissionLedger.writes after id = some write ∧ " ++
        "AgentCore.SubmissionLedger.reserved before " ++
        "(AgentCore.SubmissionWrite.identity write) = some originalId ∧ " ++
        "AgentCore.SubmissionLedger.writes before originalId = some original ∧ " ++
        "AgentCore.SubmissionWrite.identity original = AgentCore.SubmissionWrite.identity write ∧ " ++
        "AgentCore.SubmissionWrite.outcome write = " ++
        "AgentCore.SubmissionOutcome.duplicate originalId ∧ " ++
        "AgentCore.SubmissionWrite.reply write = AgentCore.SubmissionWrite.reply original" } ]

/-! ### Environments and Sessions -/

private def environmentEntries : List LexEntry :=
  [ { id := "every.environment.step"
      surface := "every environment step"
      category := "TR[AgentCore.EnvironmentLedger,AgentCore.EnvironmentLabel]"
      denotation := "AgentCore.EnvironmentStep" },
    { id := "for.the.session.use"
      surface := "for the session use"
      category :=
        "ST[AgentCore.EnvironmentLedger,AgentCore.SessionUse]" ++
        "\\ST[AgentCore.EnvironmentLedger,AgentCore.EnvironmentLabel]"
      denotation :=
        "fun cond before label => ∀ use, " ++
        "AgentCore.EnvironmentLabel.use? label = some use → cond before use" },
    { id := "a.live.current.session"
      surface := "a live current session"
      category := "ST[AgentCore.EnvironmentLedger,AgentCore.SessionUse]"
      denotation :=
        "fun ledger use => ∃ session, " ++
        "AgentCore.EnvironmentLedger.sessions ledger " ++
        "(AgentCore.SessionUse.session use) = some session ∧ " ++
        "AgentCore.SessionRecord.phase session = AgentCore.SessionPhase.live ∧ " ++
        "AgentCore.SessionUse.epoch use = AgentCore.SessionRecord.epoch session" },
    { id := "an.owning.turn.lease"
      surface := "an owning turn lease"
      category := "ST[AgentCore.EnvironmentLedger,AgentCore.SessionUse]"
      denotation :=
        "fun ledger use => ∃ session lease, " ++
        "AgentCore.EnvironmentLedger.sessions ledger " ++
        "(AgentCore.SessionUse.session use) = some session ∧ " ++
        "AgentCore.EnvironmentLedger.leases ledger " ++
        "(AgentCore.SessionRecord.owner session) = some lease ∧ " ++
        "AgentCore.LeaseToken.turn (AgentCore.SessionUse.token use) = " ++
        "AgentCore.SessionRecord.owner session ∧ " ++
        "AgentCore.TurnLease.Admits lease (AgentCore.SessionUse.token use) " ++
        "(AgentCore.SessionUse.now use)" },
    { id := "every.environment.rotation"
      surface := "every environment rotation"
      category := "TR[AgentCore.EnvironmentLedger,AgentCore.EnvironmentLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ environment, label = AgentCore.EnvironmentLabel.rotate environment) ∧ " ++
        "AgentCore.EnvironmentStep before label after" },
    { id := "session.records"
      surface := "session records"
      category := "PR[AgentCore.EnvironmentLedger]"
      denotation :=
        "fun before after => AgentCore.EnvironmentLedger.sessions after = " ++
        "AgentCore.EnvironmentLedger.sessions before" },
    { id := "every.session.close"
      surface := "every session close"
      category := "TR[AgentCore.EnvironmentLedger,AgentCore.EnvironmentLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ session, label = AgentCore.EnvironmentLabel.closeSession session) ∧ " ++
        "AgentCore.EnvironmentStep before label after" },
    { id := "for.the.closed.session"
      surface := "for the closed session"
      category :=
        "PX[AgentCore.EnvironmentLedger,AgentCore.SessionId]" ++
        "\\PO[AgentCore.EnvironmentLedger,AgentCore.EnvironmentLabel]"
      denotation :=
        "fun cond before label after => ∀ session, " ++
        "label = AgentCore.EnvironmentLabel.closeSession session → cond before session after" },
    { id := "disposed.child.facets"
      surface := "disposed child facets"
      category := "PX[AgentCore.EnvironmentLedger,AgentCore.SessionId]"
      denotation :=
        "fun _ session after => " ++
        "(∃ record, AgentCore.EnvironmentLedger.sessions after session = some record ∧ " ++
        "AgentCore.SessionRecord.phase record = AgentCore.SessionPhase.closed) ∧ " ++
        "(∀ path, AgentCore.EnvironmentLedger.files after session path = none) ∧ " ++
        "(∀ id exposure, AgentCore.EnvironmentLedger.exposures after id = some exposure → " ++
        "AgentCore.ExposureRecord.session exposure = session → " ++
        "AgentCore.ExposureRecord.live exposure = false)" } ]

/-! ### Dynamic isolates -/

private def isolateEntries : List LexEntry :=
  [ { id := "every.isolate.egress"
      surface := "every isolate egress"
      category := "TR[AgentCore.DynamicDomain,AgentCore.IsolateLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ binding destination, " ++
        "label = AgentCore.IsolateLabel.egress binding destination) ∧ " ++
        "AgentCore.IsolateStep before label after" },
    { id := "for.the.egress"
      surface := "for the egress"
      category :=
        "RE[AgentCore.DynamicDomain,AgentCore.BindingId,AgentCore.Destination]" ++
        "\\ST[AgentCore.DynamicDomain,AgentCore.IsolateLabel]"
      denotation :=
        "fun cond before label => ∀ binding destination, " ++
        "label = AgentCore.IsolateLabel.egress binding destination → " ++
        "cond before binding destination" },
    { id := "a.passed.destination"
      surface := "a passed destination"
      category := "RE[AgentCore.DynamicDomain,AgentCore.BindingId,AgentCore.Destination]"
      denotation :=
        "fun domain binding destination => ∃ capability, " ++
        "AgentCore.DynamicDomain.passed domain binding = some capability ∧ " ++
        "AgentCore.IsolateCapability.destination capability = some destination" },
    { id := "every.fresh.isolate.step"
      surface := "every fresh isolate step"
      category := "TR[AgentCore.DynamicDomain,AgentCore.IsolateLabel]"
      denotation :=
        "fun before label after => before = AgentCore.DynamicDomain.fresh ∧ " ++
        "AgentCore.IsolateStep before label after" },
    { id := "a.host.pass"
      surface := "a host pass"
      category := "ST[AgentCore.DynamicDomain,AgentCore.IsolateLabel]"
      denotation :=
        "fun _ label => ∃ binding capability, " ++
        "label = AgentCore.IsolateLabel.pass binding capability" } ]

/-! ### Interceptors -/

private def interceptorEntries : List LexEntry :=
  [ { id := "interceptor.ordering"
      surface := "interceptor ordering"
      category := "PR[AgentCore.InterceptorContribution]"
      denotation := "AgentCore.InterceptorOrder" } ]

/-! ### Blueprint materialization -/

private def definitionEntries : List LexEntry :=
  [ { id := "every.template.materialization"
      surface := "every template materialization"
      category := "TR[AgentCore.MaterializerLedger,AgentCore.MaterializeLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ blueprint template id, " ++
        "label = AgentCore.MaterializeLabel.materialize blueprint template id) ∧ " ++
        "AgentCore.MaterializeStep before label after" },
    { id := "for.the.materialization"
      surface := "for the materialization"
      category :=
        "RE[AgentCore.MaterializerLedger,AgentCore.BlueprintId," ++
        "AgentCore.SubscriptionTemplateName]" ++
        "\\ST[AgentCore.MaterializerLedger,AgentCore.MaterializeLabel]"
      denotation :=
        "fun cond before label => ∀ blueprint template id, " ++
        "label = AgentCore.MaterializeLabel.materialize blueprint template id → " ++
        "cond before blueprint (AgentCore.SubscriptionTemplate.name template)" },
    { id := "an.unmaterialized.template"
      surface := "an unmaterialized template"
      category :=
        "RE[AgentCore.MaterializerLedger,AgentCore.BlueprintId," ++
        "AgentCore.SubscriptionTemplateName]"
      denotation :=
        "fun ledger blueprint name => " ++
        "AgentCore.MaterializerLedger.installed ledger blueprint name = none" } ]

/-- The whole lexicon. Order is reviewed and stable: the emitted ledger reports entries
in this order, so a reordering is a visible diff.

The sections above are the vocabulary written while the instrument was built. Later
vocabulary is grouped by SPEC domain, one module per group under `SpecCnl/Entries/`, and
is appended below and nowhere else. -/
def lexicon : List LexEntry :=
  grammarEntries ++ runGraphEntries ++ leaseEntries ++ effectEntries ++ eventEntries ++
    authorityEntries ++ secretEntries ++ contentRetentionEntries ++ scopeEntries ++
    auditEntries ++ routingEntries ++ approvalEntries ++ submissionEntries ++
    environmentEntries ++ isolateEntries ++ interceptorEntries ++ definitionEntries ++
    Entries.Auth.entries ++ Entries.Isolate.entries ++ Entries.Commands.entries ++
    Entries.FacetInstall.entries ++ Entries.Placement.entries ++ Entries.RunGraph.entries

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
