import SpecCnl.Unit

/-!
# InterceptOrder: reviewed pairings for §4.4

These sentences cover domain admission, gate fidelity, post-preparation persistence, replay
consistency, and uniqueness of an existing admitted schedule. They do not claim unmodelled
installation, five-cut-point, or post-preparation interceptor mechanics.
-/

namespace SpecCnl.Corpus.Units.InterceptOrder

def units : List RuleUnit :=
  [ { key := "C13_INTERCEPTOR_DOMAIN_CONFINEMENT"
      atoms := ["C13-INTERCEPTOR-DOMAIN-CONFINEMENT"]
      specSection := "4.4"
      anchor := "SPEC.md:1052"
      digest := "d722b11534dbc3b87ee53545256ccb677e1d2a5ad691997f9e3e1da9c06ee878"
      sentence := "every foreign question admits no contribution"
      dropped :=
        [ "'Interceptors run only within one protection domain' is carried as a static admission property of one bundled InterceptionQuestion, not as a claim over a host's entire execution schedule",
          "'cross-domain interception MUST use asynchronous Events': the model has Event types but no relation that connects a refused MayIntercept decision to an asynchronous Event",
          "the verb admits the question's own bundled contribution; the stronger reading that no unrelated domestic contribution may intercept at the same site would be false and is not claimed" ] },
    { key := "C13_INTERCEPTOR_POST_PREPARATION"
      atoms := ["C13-INTERCEPTOR-POST-PREPARATION"]
      specSection := "4.4"
      anchor := "SPEC.md:1072"
      digest := "3028f783eb9e6b8cebe34c417fce05aed86b93f90a4327fb5db47f22d564b87e"
      sentence := "every effect step maintains prepared invocation immutability"
      dropped :=
        [ "'operation.before completes before preparation': the model has no temporal relation from an operation.before InterceptRun to an EffectLabel.persistIntent step",
          "'its final rewritten input is what the PreparedInvocation freezes and structurally digests': PreparedInvocation.items is a pure derivation, but no model relation connects an interception final value to construction of that PreparedInvocation",
          "'an interceptor MUST NOT rewrite a PreparedInvocation, Approval, EffectAttempt, or effect arguments afterward'. THE SENTENCE IS WEAKER THAN THE ATOM. The model has no interceptor action over EffectLedger or ApprovalLedger; the sentence carries only existing PreparedInvocation persistence across EffectStep",
          "'Approval, EffectAttempt, or effect arguments afterward': ApprovalLedger has no ApprovalStep, EffectAttempt immutability is separately carried by C13-EFFECT-ATTEMPT-IMMUTABLE, and effect arguments are not a distinct mutable model record" ] },
    { key := "C13_INTERCEPTOR_MODE_FIDELITY"
      atoms := ["C13-INTERCEPTOR-MODE-FIDELITY"]
      specSection := "4.4"
      anchor := "SPEC.md:1096"
      digest := "35ab25dd5e024c19f65a22f5f7492ee7a147f638db979fdb7cdf5b81302dad3e"
      sentence := "every gate firing establishes an unchanged value and every gate contribution precedes no rewrite contribution"
      dropped :=
        [ "'a gate result whose value differs is refused as a scoped block naming that interceptor': the first clause proves the value-preservation consequence but does not name the InterceptionBlock, its reason, or its interceptor field",
          "'each gate reads the final value of that cut point rather than an intermediate one': this needs one statement over an admitted schedule, its execution trace, and the gate input; the second clause carries only the cross-mode order",
          "'the mutating distinction is declared rather than discovered': InterceptorContribution.mode is a required closed field, so the absent-or-out-of-union refusal is reported separately for C13-INTERCEPTOR-MODE-DECLARED",
          "'observes and may block': the sentence permits neither a claim about observation nor a claim that a block is available for every gate behavior" ] },
    { key := "C13_INTERCEPTOR_REPLAY"
      atoms := ["C13-INTERCEPTOR-REPLAY"]
      specSection := "4.4"
      anchor := "SPEC.md:1082"
      digest := "d40e11f90fd6573c926eeb935801e6e1c74bdebb5d277c94241f4b26003dc5f8"
      sentence := "every interception step preserves replay consistency"
      dropped :=
        [ "'operation.after may rewrite only the returned presentation value; it cannot alter the effect, Receipt, or audit lineage': replayInterceptions ranges over only a value and transformations, so that durable-record boundary has no subject in this statement",
          "'the host persists its ordered transformations and trace with returned invocation evidence': the sentence carries the step invariant behind run_replay_reproduces_result, not persistence or attachment to an invocation record",
          "'replaying the same invocation presentation reuses that persisted post-effect value and trace'. THE SENTENCE IS WEAKER THAN THE ATOM. It proves replay consistency of an interception run rather than ReplayItem.ValidFor for a persisted invocation",
          "'does not rerun operation.after': replayInterceptions has no InterceptorBehavior argument, so a direct independence statement would be structural by construction rather than a discriminating bridge" ] },
    { key := "C13_INTERCEPTOR_TURN_HOSTED"
      atoms := ["C13-INTERCEPTOR-TURN-HOSTED"]
      specSection := "4.4"
      anchor := "SPEC.md:1121"
      digest := "6e099a6b3c5431daf21d9d6590d069beee23570e6a846e7659559b4551be4cf3"
      sentence := "the admitted interceptor schedule assigns at most one value"
      dropped :=
        [ "'a host executes all five cut points' and the comparison at turn.step: AgentCore.CutPoint has only before and after, so turn.step and the other cut points are unrepresented",
          "'a declaration is admitted at installation on the same terms as an operation declaration': the model has no interceptor-declaration installation relation, Facet implementation witness, or runtime-bytes-to-pinned-bytes match",
          "'ascending (mode, priority, facetId, interceptorId)' is used inside AgentCore.InterceptorOrder but not exposed as data by the sentence; the sentence carries uniqueness of its ordered admitted schedule over fixed candidates",
          "the Turn-bound host claim. THE SENTENCE IS WEAKER THAN THE ATOM. It states the one-relation uniqueness consequence of existing AdmittedSchedule rather than a Turn-hosted scheduling lifecycle" ] } ]

end SpecCnl.Corpus.Units.InterceptOrder
