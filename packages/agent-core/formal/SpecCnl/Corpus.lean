/-!
# The corpus: reviewed controlled-language input

Each record below pairs one SPEC rule unit with **one** controlled-language sentence.

Read the direction of authority carefully, because the whole instrument depends on it.

* The SPEC prose is authoritative and is **not** parsed. Nothing here compiles English.
* The controlled sentence is a **hand rewrite**, reviewed as an input. It is not derived
  from the prose and no tool claims the two mean the same thing.
* `digest` is the SHA-256 of the rule-unit body exactly as `scripts/quality/spec.mjs`
  digests it. The gate recomputes it. When the prose moves, the digest breaks and the
  pairing returns for review; that is the only mechanism binding the two, and it is a
  review trigger, not a proof of agreement.
* `dropped` records, clause by clause, what the sentence does **not** carry. Not one
  sentence in this corpus carries everything its rule unit says.

Declaration names are derived from `key`, so a record cannot name a proposition, bridge,
or discharge that belongs to a different unit.

A rule unit is rendered by exactly one sentence. Multi-clause units coordinate inside the
controlled language with `and`, so there is no Lean-level glue between clauses and every
connective a unit depends on is reviewed controlled language.
-/

namespace SpecCnl.Corpus

/-- One reviewed pairing of a SPEC rule unit with a controlled-language sentence. -/
structure RuleUnit where
  /-- Stable key. Declaration names derive from it. -/
  key : String
  /-- Every §13 atom anchored to this rule unit. -/
  atoms : List String
  /-- SPEC section the rule unit sits in. -/
  specSection : String
  /-- `SPEC.md:<line>` of the atom anchor when the record was reviewed. Advisory: lines
  move, and the digest is what the gate enforces. -/
  anchor : String
  /-- SHA-256 of the digested rule-unit body. -/
  digest : String
  /-- The reviewed controlled-language sentence. -/
  sentence : String
  /-- Clauses of the rule unit the sentence does not carry, and why. -/
  dropped : List String
  deriving Repr, Inhabited

def RuleUnit.proposition (unit : RuleUnit) : String := s!"SpecCnl.Sentences.cnl_{unit.key}"
def RuleUnit.handProposition (unit : RuleUnit) : String := s!"SpecCnl.Bridge.hand_{unit.key}"
def RuleUnit.bridge (unit : RuleUnit) : String := s!"SpecCnl.Bridge.bridge_{unit.key}"
def RuleUnit.discharge (unit : RuleUnit) : String := s!"SpecCnl.Proofs.proved_{unit.key}"

/-- Every audited declaration of a unit, in report order. -/
def RuleUnit.auditedNames (unit : RuleUnit) : List String :=
  [unit.proposition, unit.handProposition, unit.bridge, unit.discharge]

def units : List RuleUnit :=
  [ { key := "C13_RUN_ANCESTRY"
      atoms := ["C13-RUN-ANCESTRY"]
      specSection := "5.2"
      anchor := "SPEC.md:1601"
      digest := "a918901377c9455fd9632715990d25aecc26ace44315cdcd059b652f428b8ee0"
      sentence := "ancestry depends only on the commits"
      dropped :=
        [ "reachability queries as an obligation distinct from ancestry",
          "'not merely head moves' as a negative claim about conforming stores, which is \
           about store implementations rather than about the model" ] },
    { key := "C13_SUBSCRIPTION_ACCEPTED_TIERS"
      atoms := ["C13-SUBSCRIPTION-ACCEPTED-TIERS"]
      specSection := "6.1"
      anchor := "SPEC.md:2313"
      digest := "20e3a9bdfab3b04999e656fdcfedbe26a1912f6878e5862bc4fa1e03ee9f444d"
      sentence := "every tier predicate is the accepted set of some subscription"
      dropped :=
        [ "'TrustTier is categorical, not ordered': the absence of an order instance is a \
           signature-level negative and is not statable inside the theory. The sentence \
           states the strongest positive consequence instead, because an order would force \
           the accepted set to be an up-set",
          "'there is no minimum-tier comparison', the same signature-level negative" ] },
    { key := "C13_TRUST_VERIFIED_INGRESS"
      atoms := ["C13-TRUST-VERIFIED-INGRESS"]
      specSection := "6.1"
      anchor := "SPEC.md:2332"
      digest := "9ebcd9bde87e3425e17d8d52784607de4dc3f1ecd94dc56374becd3ef701dd26"
      sentence := "every published event has no asserted tier"
      dropped :=
        [ "'exposes declared endpoints': the model has no endpoint-declaration relation",
          "'verifies per verification': the model has no verification configuration",
          "'unverified requests MUST NOT mint Events'. THE SENTENCE IS WEAKER THAN THE \
           ATOM. The model has no ingress, and AgentCore.deriveChannelTrust maps \
           unverified provenance to TrustTier.external, so the model admits an Event \
           minted from an unverified request. The sentence carries only the \
           host-derives-the-tier half. A green bridge here is not evidence for the atom's \
           main clause" ] },
    { key := "C13_TURN_LEASE_EXPIRY"
      atoms := ["C13-TURN-LEASE-EXPIRY"]
      specSection := "5.3"
      anchor := "SPEC.md:2003"
      digest := "345c281041a50e304408102fe36242689c57f2b428dcc01eda7bbaf12e27ae03"
      sentence :=
        "every lease reclaim requires the recorded expiry is at most the stated time \
         for the reclaim"
      dropped :=
        [ "'expiresAt > now' as a requirement of every claim and renew, not only of reclaim",
          "'MUST be rejected without it' as a statement about the rejection path" ] },
    { key := "C13_EFFECT_ATTEMPT_IMMUTABLE"
      atoms := ["C13-EFFECT-ATTEMPT-IMMUTABLE"]
      specSection := "7.4"
      anchor := "SPEC.md:3023"
      digest := "741c0f0d88df53144d2be57aa6d78df5adccff0b2076413b7a3f11a87243f0c1"
      sentence := "every effect step maintains attempt immutability"
      dropped :=
        [ "'write-ahead': the model has no ordering between recording an attempt and the \
           effect crossing the boundary",
          "'that one item may cross the effect boundary'",
          "'Retry appends a new ordinal'",
          "'pre-effect denial or cancellation never creates one'" ] },
    { key := "C13_RECEIPT_ID_NAMESPACE"
      atoms := ["C13-RECEIPT-ID-NAMESPACE"]
      specSection := "7.4"
      anchor := "SPEC.md:3131"
      digest := "9659de19ad013cec0d4bb18385758e5836b1dc48f940f3bbe7e633520cf48ca4"
      sentence := "every effect step preserves disjoint receipt ids"
      dropped :=
        [ "'allocated from one owning-Actor namespace': AgentCore.ReceiptId carries no \
           owner, so the namespace is unrepresented and only the disjointness half is \
           expressible",
          "'AttemptReceipt.previous and AuditKind.receiptSuperseded refer to that same \
           namespace'",
          "'An id is never reused' as a claim over a whole run rather than over one step" ] },
    { key := "C13_RUN_GRAPH_ARITY"
      atoms := ["C13-RUN-GRAPH-ARITY"]
      specSection := "5.2"
      anchor := "SPEC.md:1607"
      digest := "1c9071af12794d003755e252eeac45d387f51c84239c66ac5b57921a4f34c598"
      sentence :=
        "every merge append requires the parent count equals two for the appended commit"
      dropped :=
        [ "'one root with zero parents': AgentCore.GraphLabel.append never carries a root \
           commit, since a root arrives through startRun or spawnChild, so a root clause \
           written over appends would be vacuously true and is refused rather than counted",
          "'exactly one parent equal to its branch head at append'",
          "'no other parent arity is valid' as an exhaustiveness claim over the arity rule, \
           which is a property of the definition rather than of a transition",
          "'Appending atomically advances only the target branch head'",
          "'Commit records and parent order never change'" ] },
    { key := "C13_RUN_UNDO_FENCE"
      atoms := ["C13-RUN-UNDO-FENCE"]
      specSection := "5.2"
      anchor := "SPEC.md:1592"
      digest := "98c0af4aa8faa9f44dffb722b1854786405837a5d32dac898a46eb376a146889"
      sentence :=
        "every undo append requires an unheld branch for the appended commit and every \
         undo append requires a selected ancestor for the appended commit"
      dropped :=
        [ "'MUST FIRST fence': the ordering is rendered as the source-state precondition \
           the model enforces, because the model has no temporal operator",
          "the concessive 'whether or not its lease has expired'",
          "the liveness half, 'rejected until the Turn is fenced or completes': a safety \
           reformulation carries the refusal but not the eventual admission" ] },
    { key := "C13_AUTH_GUEST_VERIFICATION"
      atoms := ["C13-AUTH-GUEST-VERIFICATION"]
      specSection := "3.3"
      anchor := "SPEC.md:394"
      digest := "8033772209b314ef230d10a32c48878e4ee1f41aef345f6067ad1aac42347b5f"
      sentence := "a verified guest subject holds before every role materialization"
      dropped :=
        [ "'a verification failure denies' as a statement about the denial path",
          "'the wire protocol for a token or a callback is a substrate/profile concern'",
          "'the host Tenant's policy declares the issuer or endpoint'",
          "'this document fixes the three schemes': a claim about the specification \
           document, not about the model" ] },
    { key := "C13_CONTENT_RESOLUTION"
      atoms := ["C13-CONTENT-RESOLUTION"]
      specSection := "8.2"
      anchor := "SPEC.md:3284"
      digest := "b81e0e0a785868b07c2713bdc8f6fe8b656fbdfb5ff12312b7f61b4fb9786c01"
      sentence :=
        "every content resolve requires a home tenant or a granted tenant for the \
         resolved reference"
      dropped :=
        [ "'Every ContentRef IN THIS SPECIFICATION': a claim about the specification \
           document, not about the model",
          "'MUST resolve through a ContentStore', and the enumeration of run inputs, \
           checkpoints, instructions, results, and slate sources",
          "'A ContentStore belongs to exactly one Tenant': AgentCore.ContentRef.tenant is \
           a field, so a rendering of this clause would be functional by construction and \
           therefore vacuous" ] },
    { key := "C13_RUN_ACCEPTANCE_OBLIGATION"
      atoms := ["C13-RUN-ACCEPTANCE-OBLIGATION"]
      specSection := "5.2"
      anchor := "SPEC.md:1759"
      digest := "956fa30bb46576efa28d801cbd136e8ec5765d57785f167829e33c93e5570063"
      sentence := "the head tree assigns at most one value"
      dropped :=
        [ "the declaration of criteria when a Run opens, and the refusal to redeclare one \
           identity with different verifiers",
          "'a verdict names exactly one criterion'",
          "satisfaction by an AcceptanceVerdict naming an attempted Receipt whose outcome \
           is succeeded and whose subject equals the head tree digest",
          "'the Receipt MUST come from the exact Operation the criterion names'",
          "snapshotting an unsatisfied obligation into the SettlementObligation, and the \
           rule that a Run is not Settled while it stands",
          "'A criterion bounds nothing', and the rule for a Run that declares none",
          "the sentence carries only the clause 'satisfaction is never selectable by the \
           caller that asks': the Run's head tree is a function of the store and the Run" ] } ]

/-- The unit with this key, if any. -/
def find? (key : String) : Option RuleUnit := units.find? (fun unit => unit.key == key)

/-- Every audited declaration in the corpus, in report order. -/
def auditedNames : List String := (units.map RuleUnit.auditedNames).flatten

/-- Kernel-checked divergence evidence, audited alongside the units. A finding that has
been resolved in the model stays here as a discriminating witness: see
`SpecCnl.Divergence` for why removing it would discard the only evidence that the
resolving premise does any work. -/
def divergenceNames : List String :=
  [ "SpecCnl.Divergence.preFixOrderingHolds",
    "SpecCnl.Divergence.prefix_guest_verification_diverges",
    "SpecCnl.Divergence.current_step_is_prefix_step",
    "SpecCnl.Divergence.fix_is_strict" ]

/-- Every declaration the axiom report designates. -/
def allAuditedNames : List String := auditedNames ++ divergenceNames

/-- Structural refusals of the corpus itself: a duplicate key, a duplicate atom, an empty
atom list, or a digest that is not a lowercase SHA-256. -/
def corpusRefusals : List String := Id.run do
  let mut refusals : List String := []
  let mut keys : List String := []
  let mut atoms : List String := []
  for unit in units do
    if keys.contains unit.key then
      refusals := refusals ++ [s!"duplicate corpus key '{unit.key}'"]
    keys := unit.key :: keys
    if unit.atoms.isEmpty then
      refusals := refusals ++ [s!"corpus unit '{unit.key}' names no atom"]
    for atom in unit.atoms do
      if atoms.contains atom then
        refusals := refusals ++ [s!"atom '{atom}' is claimed by more than one corpus unit"]
      atoms := atom :: atoms
    if unit.digest.length != 64 ||
        !unit.digest.all (fun c => c.isDigit || (c >= 'a' && c <= 'f')) then
      refusals := refusals ++ [s!"corpus unit '{unit.key}' digest is not a SHA-256 hex digest"]
    if unit.dropped.isEmpty then
      refusals := refusals ++
        [s!"corpus unit '{unit.key}' records no dropped clause; not one sentence in this \
            corpus carries everything its rule unit says, so an empty list is unreviewed \
            rather than complete"]
  return refusals

end SpecCnl.Corpus
