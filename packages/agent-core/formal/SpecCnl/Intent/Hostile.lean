import SpecCnl.Intent.Report

/-!
# Hostile assertions for the intent language

Kernel-checked assertions that this language refuses what it must. Each `#guard` fails the
build, so none of it is a report anybody has to read.

The `example` blocks use `intent_text%` rather than `intent%`, because their point is that a
sentence is *refused* at elaboration time. A refusal that only appeared in a report could be
reported and ignored; an elaboration error cannot be.
-/

namespace SpecCnl.Intent.Hostile

/-! ## The corpus, the table, and the mirrors hold together -/

#guard corpusRefusals.isEmpty
#guard adversarialRefusals.isEmpty
#guard lexiconRefusals.isEmpty
#guard Search.probeRefusals.isEmpty

/-! ## The four verdicts are the four the records expect

`Search.verdictRefusals` compares the bounded search's proposal against every record's
expectation. Three distinct verdicts are exercised, and one of them is CONSISTENT on an
adversarial record: a checker that answered INCONSISTENT to everything adversarial would
pass every other assertion here and fail this one. -/

#guard Search.verdictRefusals.isEmpty
#guard allRecords.length == 4
#guard (allRecords.map (fun record => record.expected.render)) ==
  ["CONSISTENT", "OUTSIDE-MODEL", "INCONSISTENT", "CONSISTENT"]
#guard (allRecords.filter (fun record => record.expected == Verdict.consistent)).length == 2

/-! ## The minimal core and the smallest instance are the ones the refutations use

`INT_ADV_EARLY_LATE_RECLAIM` is refuted at the atom that bounds the reclaim time, and
`INT_ADV_UNHELD_RECLAIM` at the atom that demands an unheld lease. Each record's own
`refuted_` theorem is stated at that core, and `not_permission_of_core` is what carries it to
the whole safety set. -/

#guard (match Search.observed (recordWithKey? "INT_ADV_EARLY_LATE_RECLAIM").get! with
  | .ok found => found.core == ["LEASE_RECLAIM_BY_TWO"]
  | .error _ => false)

#guard (match Search.observed (recordWithKey? "INT_ADV_UNHELD_RECLAIM").get! with
  | .ok found => found.core == ["LEASE_RECLAIM_UNHELD"]
  | .error _ => false)

#guard (match Search.observed (recordWithKey? "INT_ADV_UNHELD_RECLAIM").get! with
  | .ok found =>
      found.excluded ==
        some "lease(turn=0, holder=0.0, epoch=0, expiry=1) -- reclaim(holder=0.0, now=1, expiresAt=2)"
  | .error _ => false)

/-! ## Every negative sentence is refused, and refused for the recorded reason -/

#guard negatives.length == 8
#guard negativeFailures.isEmpty
#guard admittedNegatives.isEmpty
#guard (negatives.filter (fun case =>
  match case.kind with | .ambiguous _ => true | _ => false)).length == 1

/-! ## Every adjacent transposition of every record sentence is refused -/

#guard allScrambles.length == 72
#guard admittedScrambles.isEmpty
#guard roundTripFailures.isEmpty

/-! ## Every entry this language adds is exercised

An unexercised paradigm cell is a grammar bigger than the grammar with evidence behind it.
The complete connective paradigm has `preserve`, `maintain`, `establish` and
`are impossible` too, and none of them ship. -/

/-- Every head every admitted intent reading uses, atoms and records alike. -/
private def exercised : List String :=
  (atoms.flatMap (fun atom =>
      match compileIntent atom.sentence with
      | .ok admission => admission.heads
      | .error _ => [])) ++
    allRecords.flatMap (fun record =>
      match record.sentence with
      | .ok sentence =>
          match compileIntent sentence with
          | .ok admission => admission.heads
          | .error _ => []
      | .error _ => [])

#guard addedEntries.length == 7
#guard (addedEntries.filter (fun entry => exercised.contains entry.id == false)).isEmpty

/-! ## Ambiguity is a hard error, and it returns both readings

Three atoms joined by the ordinary coordinator associate two ways. The refusal carries both
rendered readings, which is the counterexample a human needs in order to pick one; a parser
that returned its first reading could never report that an intent has two. -/

#guard observedKind
  "lease reclaims are possible and lease reclaims require an unheld lease and \
   lease reclaims are possible" == some (.ambiguous 2)

/--
error: refused: 'lease reclaims are possible and lease reclaims require an unheld lease and lease reclaims are possible' has 2 readings: intent.and(intent.possible(lease.reclaims : GD[AgentCore.TurnLease,AgentCore.LeaseLabel]) : IN[AgentCore.TurnLease,AgentCore.LeaseLabel], intent.and(intent.requires(an.unheld.lease : ST[AgentCore.TurnLease,AgentCore.LeaseLabel], lease.reclaims : GD[AgentCore.TurnLease,AgentCore.LeaseLabel]) : IN[AgentCore.TurnLease,AgentCore.LeaseLabel], intent.possible(lease.reclaims : GD[AgentCore.TurnLease,AgentCore.LeaseLabel]) : IN[AgentCore.TurnLease,AgentCore.LeaseLabel]) : IN[AgentCore.TurnLease,AgentCore.LeaseLabel]) : IN[AgentCore.TurnLease,AgentCore.LeaseLabel] | intent.and(intent.and(intent.possible(lease.reclaims : GD[AgentCore.TurnLease,AgentCore.LeaseLabel]) : IN[AgentCore.TurnLease,AgentCore.LeaseLabel], intent.requires(an.unheld.lease : ST[AgentCore.TurnLease,AgentCore.LeaseLabel], lease.reclaims : GD[AgentCore.TurnLease,AgentCore.LeaseLabel]) : IN[AgentCore.TurnLease,AgentCore.LeaseLabel]) : IN[AgentCore.TurnLease,AgentCore.LeaseLabel], intent.possible(lease.reclaims : GD[AgentCore.TurnLease,AgentCore.LeaseLabel]) : IN[AgentCore.TurnLease,AgentCore.LeaseLabel]) : IN[AgentCore.TurnLease,AgentCore.LeaseLabel]
-/
#guard_msgs in
example : Lts AgentCore.TurnLease AgentCore.LeaseLabel → Prop :=
  intent_text% "lease reclaims are possible and lease reclaims require an unheld lease and \
                lease reclaims are possible"

/-! ## A transition family is not a guard, and a guard is not a condition

`every lease reclaim` denotes the model's own step relation; `require` takes a guard, which
denotes a label shape and nothing else. Admitting the first sentence below would let an
intent quantify over `AgentCore.LeaseStep` instead of over the platform's relation, which is
the whole distinction between the two languages. -/

/--
error: refused: no reading of 'every lease reclaim require an unheld lease' as an intent
-/
#guard_msgs in
example : Lts AgentCore.TurnLease AgentCore.LeaseLabel → Prop :=
  intent_text% "every lease reclaim require an unheld lease"

/--
error: refused: no reading of 'lease reclaims requires an unheld lease' as a sentence
-/
#guard_msgs in
example : Prop := cnl% "lease reclaims requires an unheld lease"

/--
error: refused: no reading of 'lease reclaims require lease reclaims' as an intent
-/
#guard_msgs in
example : Lts AgentCore.TurnLease AgentCore.LeaseLabel → Prop :=
  intent_text% "lease reclaims require lease reclaims"

/-! ## No surface carries both a transition family and a guard

The one rule this language needs and the controlled language does not. A word with both
would give one sentence an `S` reading and an `IN` reading, so which proposition the sentence
denoted would depend on which admission path a caller took. The rule is shown to
discriminate on a table built to break it, because a rule that accepted everything would
look identical in a green run. -/

private def overlapProbe : List LexEntry :=
  [ { id := "probe.family"
      surface := "lease reclaims"
      category := "TR[AgentCore.TurnLease,AgentCore.LeaseLabel]"
      denotation := "AgentCore.LeaseStep" },
    { id := "probe.guard"
      surface := "lease reclaims"
      category := "GD[AgentCore.TurnLease,AgentCore.LeaseLabel]"
      denotation := "fun _ _ => True" } ]

#guard (overlapRefusals overlapProbe).length == 1
#guard (overlapRefusals lexicon).isEmpty
#guard (overlapRefusals [overlapProbe.head!]).isEmpty

/-! ## An unresolved ledger is refused

No sentence in this lexicon can leave a ledger open: the only guard entry names its state and
label types outright, so every `IN` reading is resolved. The refusal is asserted on the
category directly for that reason — the same way an unsafe entry id is asserted on a value
the lexicon cannot produce. -/

#guard (ledgerOf (Cat.in_ (Ty.var "s") (Ty.var "l"))).toOption.isNone
#guard (ledgerOf (Cat.in_ (Ty.var "s") (Ty.con "AgentCore.LeaseLabel"))).toOption.isNone
#guard (ledgerOf (Cat.in_ (Ty.con "AgentCore.TurnLease")
  (Ty.con "AgentCore.LeaseLabel"))).toOption.isSome
#guard (ledgerOf Cat.s).toOption.isNone

/-! ## An unknown key has no intent -/

/--
error: no intent atom or record 'INT_NOT_A_RECORD'
-/
#guard_msgs in
example : Lts AgentCore.TurnLease AgentCore.LeaseLabel → Prop := intent% "INT_NOT_A_RECORD"

/-! ## A wrong denotation is a Lean type error

Every head the grammar emits is ascribed the type its category interprets to, so a
mis-declared entry cannot elaborate. The ascription is visible in the emitted term. -/

#guard (match compileIntent "lease reclaims are possible" with
  | .ok admission =>
      admission.lean.startsWith "(((SpecCnl.Intent.inPossible) : ((AgentCore.TurnLease)"
  | .error _ => false)

/-! ## The category atoms round-trip -/

#guard (Cat.ofString "GD[s,l]").toOption.map Cat.render == some "GD[s,l]"
#guard (Cat.ofString "IN[s,l]").toOption.map Cat.render == some "IN[s,l]"
#guard (Cat.ofString "(GD[s,l]\\IN[s,l])/ST[s,l]").toOption.map Cat.render ==
  some "((GD[s,l]\\IN[s,l])/ST[s,l])"
#guard (Cat.in_ (Ty.con "a") (Ty.con "b")).atomNames == ["IN"]
#guard (Cat.gd (Ty.con "a") (Ty.con "b")).atomNames == ["GD"]

/-! ## The controlled language is unchanged

The intent table extends the controlled language's own. These two assertions are what says
the extension took nothing away: every controlled-language entry is still there, in order,
and the controlled language's own refusal list is still empty. -/

#guard (lexicon.take _root_.SpecCnl.lexicon.length).map LexEntry.id ==
  _root_.SpecCnl.lexicon.map LexEntry.id
#guard _root_.SpecCnl.lexiconRefusals.isEmpty

end SpecCnl.Intent.Hostile
