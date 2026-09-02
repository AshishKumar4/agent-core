import SpecCnl.Unit

/-!
# Protocol: reviewed pairings for §8.1, §8.3, §8.4, and §8.5

These units concern the Actor-local state machine and the dispatcher at the command
protocol boundary. Three model consequences are bridgeable: activation binds storage to the
Actor it started, that binding survives every reachable Actor step, and every admitted
protocol command passed the Actor's current-fence gate. The dispatcher also proves the
fresh linked write/audit-table update that every request produces.

Four rule units are deliberately not corpus records. `C13-CODEC-VERSIONING` and
`C13-CODEC-INCOMPATIBILITY-TOTAL` need a codec version declaration, compatibility reader,
and typed incompatibility result; no such construct exists in `AgentCore`.
`C13-PROTOCOL-FAMILY-ENVELOPE-POLICY` needs a per-family envelope-policy table and
malformed-field classification, while `DispatchPolicy` has only a generic revision predicate
and a lease-requirement function. `C13-OWNERSHIP-AUTHORITY-RECORDS` needs an Actor-owned
Binding, Grant, and ScopeEpoch record plane; `ActorStorage` has identity, recovery, and a
journal only, and `AuthorityLedger` is not coupled to an owning Actor transaction.

The dispatcher is polymorphic in its domain state. The grammar has no type-parameter
quantifier, so its one non-vacuous sentence fixes that otherwise opaque state to `Nat`; its
proof uses only the parametric dispatcher theorem and no property of `Nat`.
-/

namespace SpecCnl.Corpus.Units.Protocol

def units : List RuleUnit :=
  [ { key := "C13_OWNERSHIP_ACTOR_CONTRACT"
      atoms := ["C13-OWNERSHIP-ACTOR-CONTRACT"]
      specSection := "8.1"
      anchor := "SPEC.md:3287"
      digest := "d2288204ff4f93a19dac3ecef0aa7a3d0651ce7137f994d0e984238751ff4ec1"
      sentence :=
        "every protocol command requires a current actor fence for the protocol command"
      dropped :=
        [ "'one authoritative coordination unit owning its mailbox, local transaction \
           boundary, lifecycle, recovery, and fencing state'. THE SENTENCE IS WEAKER THAN \
           THE ATOM. AgentCore.ActorNode carries storage, phase, and one optional pending \
           transaction, but no mailbox and no ActorRef-to-node ownership relation; the \
           sentence carries only the gate every admitted command passed",
          "'MUST serialize conflicting commands': ActorStep has no conflict relation or \
           mailbox queue, so the model cannot state which commands conflict or compare \
           their serialization",
          "'recover state before serving' and 'commit at declared linearization points': \
           ActorRecovery records an epoch and activation count, and ActorStep.commit applies \
           staged writes, but no command declares a recovery projection or a linearization \
           point",
          "'reject stale fences' across a restart as a whole-trace claim. \
           AgentCore.pre_restart_fence_never_readmitted proves that stronger trace fact, \
           but this grammar shape reads one command transition and carries its current-fence \
           admission guard",
          "the Actor-role enumeration: ActorRef has tenant, workspace, run, and external \
           constructors, but no Environment or Slate-host actor role" ] },
    { key := "C13_OWNERSHIP_SINGLE_OWNER"
      atoms := ["C13-OWNERSHIP-SINGLE-OWNER"]
      specSection := "8.4"
      anchor := "SPEC.md:3361"
      digest := "a2eb87311c3e9df1cb6b44f080fa06eeab630cffa17ea1818eaba68827d11f2e"
      sentence :=
        "every protocol activation establishes a bound actor identity for the protocol \
         activation and every reachable protocol actor step maintains bound actor identity"
      dropped :=
        [ "'Every record type names exactly one owning Actor'. THE SENTENCE IS WEAKER THAN \
           THE ATOM. It concerns AgentCore.ActorStorage's identity and recovery rows only; \
           the model has no general record-type-to-owning-Actor relation or ownership-map \
           artifact",
          "the sentence carries the activation and one-step preservation facts from which \
           AgentCore.one_storage_serves_one_actor derives same-Actor activation over a \
           trace. It does not itself quantify two activations separated by an arbitrary \
           trace, because the grammar has no trace-quantifying sentence form",
          "'Other actors hold identifiers and rebuildable indexes only', cache versioning and \
           cache-miss behavior: no cross-Actor index, cache, or locator record is in the \
           ActorStorage model",
          "'Cross-actor reads use RPC or explicitly versioned snapshots — never dual writes': \
           AgentCore.ActorStep is one Actor's local transition system and has neither an RPC \
           relation nor a snapshot or dual-write operation" ] },
    { key := "C13_PROTOCOL_REJECTION_ROOT"
      atoms := ["C13-PROTOCOL-REJECTION-ROOT"]
      specSection := "8.5"
      anchor := "SPEC.md:3451"
      digest := "009f2a8779362518921ccd509e077f1d2771ca5d328906b7c381c5f40a066b38"
      sentence :=
        "every protocol request establishes a linked write audit record for the protocol request"
      dropped :=
        [ "'A valid callerCause MUST preexist and be a permitted typed cause', and the \
           host-created attributable write root on rejection. DispatcherLedger stores only \
           an AuditId-to-WriteRecordId link; AgentCore.Dispatcher deliberately leaves the \
           typed causal-chain content of that id uninterpreted",
          "the accepted-request Invocation root, malformed caller-and-command omission, and \
           raw-envelope-digest coverage. CommandEnvelope and WriteRecord expose some of \
           those fields, but this payload-indexed sentence carries the linked table update, \
           not their field-level relationship to the submitted raw envelope",
          "the grammar fixes the dispatcher's opaque domain state to Nat. The model theorem \
           is parametric in that state and uses no property of Nat, but this grammar has no \
           type-parameter quantifier to render the all-domain form",
          "'WriteRecord and AuditRecord contain each other's preallocated ids': the model has a \
           WriteRecord.audit field and an audit index, not an AuditRecord structure with the \
           reciprocal field",
          "RunCommit-specific §5.2 enforcement, post-commit cross-Actor observation, and §6.2 \
           reservation bridges, which have no relation in DispatcherLedger" ] } ]

end SpecCnl.Corpus.Units.Protocol
