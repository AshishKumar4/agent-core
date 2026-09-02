import SpecCnl.Unit

/-!
# NoRetry: reviewed pairings for §5.6

The §5.6 paragraph that says the Turn lifecycle is closed: there is no `retryTurn`
transition, a terminal Turn is never resurrected, and starting another Turn inherits
nothing from the one that ended. Five reachable rule units say this five times over, once
about the normative transition set and once each about the runtime, the command protocol,
the supported package surface, and the durable record and migration registries.

**Four of the five are claims about the absence of a symbol in an artifact, and only the
first is statable inside the theory.** That asymmetry is this group's main result, and it
is the same shape the corpus already met at `C13-SUBSCRIPTION-ACCEPTED-TIERS`: "no
`retryTurn` constructor exists" is a signature-level negative with nothing to quantify
over, because a proposition would have to name the constructor it says is missing.

What *is* statable is the strongest positive consequence of the closed label set, and it is
strong: `AgentCore.GraphLabel` is closed, `AgentCore.GraphStep` is the whole normative
relation over it, and the six labels that write the `turns` table each demand a live status
of the record they rewrite. So the three terminal statuses are absorbing under every label
there is, which is exactly "a failed or cancelled Turn is never resurrected". The second
clause carries the authority half from the other end: a started Turn's lease is
`AgentCore.TurnLease.initial`, whose holder is `none`, so it admits no token whatsoever.

The four artifact atoms are reported unbridged rather than restated under this record's
sentence. `AgentCore` models no runtime operation table, no protocol command family for
Turns — `AgentCore.CommandRegistry` and `AgentCore.CommandLabel` are the §4.3 Scope command
model and mention no `TurnId` at all, while `AgentCore.Dispatcher.CommandEnvelope.command`
is a free `String` and so is not a closed family to quantify over — no package export
surface, and no durable-record schema or migration registry: `grep -r
'upcast\|migrationRegistry\|schemaVersion' formal/` finds nothing. Writing this record's
sentence again under those four digests would claim a bridge for content those atoms do
not own.
-/

namespace SpecCnl.Corpus.Units.NoRetry

def units : List RuleUnit :=
  [ { key := "C13_TURN_NO_RETRY"
      atoms := ["C13-TURN-NO-RETRY"]
      specSection := "5.6"
      anchor := "SPEC.md:2272"
      digest := "49d453b46ae784c4a74e5124f0100779b2e86a6bdbb11ba21d1f191e31899c6c"
      sentence :=
        "every graph step maintains terminal turn finality and every turn start \
         establishes an unheld initial lease for the started turn"
      dropped :=
        [ "'There is no normative retryTurn transition'. THE SENTENCE IS WEAKER THAN THE \
           ATOM. AgentCore.GraphLabel is a closed inductive whose Turn labels are \
           startTurn, claimTurn, suspendTurn, resumeTurn, forceCancelSibling and \
           terminalize, and AgentCore.LeaseLabel is closed over claim, renew, reclaim, \
           suspendFence, resume and terminalFence; neither has a retry constructor. The \
           absence of a constructor is a signature-level negative that is not statable \
           inside the theory, because a proposition asserting it would have to name the \
           constructor it says does not exist. What the sentence carries instead is the \
           strongest positive consequence of that closed set: no transition of any label \
           takes a Turn from a terminal status back to a live one",
          "'ordinary admission of another Turn creates no retry linkage': AgentCore.Turn \
           carries run, branch, pins, status and lease and no field naming a prior Turn, \
           and AgentCore.ForcedCancellation — the only record relating two TurnIds — is a \
           cancellation fence with its own control receipt and audit rather than a retry \
           edge. A missing field is a signature-level absence for the same reason a \
           missing constructor is, so the second clause carries only the inherited-\
           authority half",
          "'The Turn lifecycle above is closed' read as the shape of the lifecycle — which \
           status may follow which — is not carried. The sentence says only that the three \
           terminal statuses are absorbing. Where queued becomes running, running becomes \
           suspended, and suspended becomes running are the status premises of \
           AgentCore.GraphStep.claimTurn, .suspendTurn and .resumeTurn, and one sentence \
           over one transition cannot state the whole graph of admissible successors",
          "the first clause is a property of AgentCore.GraphStep and deliberately not of \
           AgentCore.LeaseStep. The lease relation on its own admits a claim or a resume \
           after a terminalFence, because the fence clears the holder and an unheld lease \
           is exactly what those two labels require; AgentCore.lease_turn_immutable and \
           AgentCore.terminal_fence_is_atomic bound what a fence does to the lease but \
           neither forbids re-acquisition. The non-resurrection the sentence carries comes \
           from the Turn-status premises the graph step adds on top, which is why the \
           relation ranges over AgentCore.GraphStore",
          "'inherited authority' read as inherited pins: AgentCore.GraphStep.startTurn \
           requires turn.pins.runPins = run.pins, so a fresh Turn does carry its Run's \
           exact-source pins by construction, and that inheritance is intended. The atom's \
           concern is authority to act, which in this model is the lease, and that is what \
           the second clause states — TurnLease.initial has no holder, so \
           TurnLease.Admits refuses every token at every time",
          "the four artifact atoms of the same §5.6 paragraph. \
           C13-TURN-NO-RETRY-RUNTIME, C13-TURN-NO-RETRY-PROTOCOL, C13-TURN-NO-RETRY-EXPORT \
           and C13-TURN-NO-RETRY-RECORD are claims about a runtime operation table, a \
           protocol command family, a package export surface, and a durable-record and \
           migration registry, none of which AgentCore represents. They are reported \
           unbridged with those absences rather than restated here, because this record's \
           sentence carries the normative-transition atom's clause and claiming it four \
           more times would report five bridges for one piece of content" ] } ]

end SpecCnl.Corpus.Units.NoRetry
