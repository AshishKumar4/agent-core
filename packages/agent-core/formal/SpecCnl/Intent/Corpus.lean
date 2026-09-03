import SpecCnl.Intent.Ledgers

/-!
# The reviewed intent records

The direction of authority is the opposite of `SpecCnl.Corpus`. A rule unit is prose the
sentence has to carry, and the record is bound to that prose by a digest. An intent has no
prose to be bound to: it is the source. So a record here carries no `dropped` list — there
is nothing it is a rewrite of — and carries instead the §13 atoms it *sharpens*, an expected
verdict, and the corpus unit its own atom is proved equal to.

A record's sentence is not written here. It is the `and`-join of its atoms' sentences, so
the text a human ratifies is derived from the atoms rather than retyped beside them and the
two cannot drift. Three atoms would make that join ambiguous — `A and B and C` has two
readings and the grammar refuses to choose — which is exactly why a record is two atoms in
stage 1 and why `SpecCnl.Intent.Hostile` keeps the three-atom join as a refusal.

The review question inverts too. For a rule unit a human answers "does the sentence mean
what the prose means", and the `dropped` list is what makes that answerable. For an intent a
human answers "does the sentence mean what I wanted", and no tool decides that: the
ambiguity refusal, the verdict, and the witness or refutation exist to make the answer
informed.
-/

namespace SpecCnl.Intent

/-- What the contradiction checker returns.

The three decided names are the ones `VERIFIED_SOFTWARE_WORKFLOW.md` already reserves.
`unproved` is the fall-through, and it is not a verdict a record may expect: it is what the
checker returns when the proof a verdict needs is absent, so a record expecting it would be
a record that claims nothing. -/
inductive Verdict where
  /-- Some relation the SPEC model admits satisfies every atom, and a witness names one. -/
  | consistent
  /-- No relation at all satisfies every atom: the atoms contradict each other. -/
  | inconsistent
  /-- The atoms are consistent, but the SPEC model admits nothing that realises them. -/
  | outsideModel
  /-- Neither witnessed nor refuted. -/
  | unproved
  deriving DecidableEq, Repr, Inhabited

def Verdict.render : Verdict → String
  | .consistent => "CONSISTENT"
  | .inconsistent => "INCONSISTENT"
  | .outsideModel => "OUTSIDE-MODEL"
  | .unproved => "UNPROVED"

/-- One intent atom: the shortest `IN` sentence that says one thing, with the polarity its
connective gives it. The polarity is checked twice — against the head's entry in
`SpecCnl.Intent.connectives`, and against a named theorem proving the denotation really is
downward or upward closed. -/
structure IntentAtom where
  key : String
  ledger : String
  sentence : String
  polarity : Polarity
  /-- What this atom demands, in one sentence, for a reviewer comparing it to the intent. -/
  note : String
  deriving Repr, Inhabited

/-- One reviewed intent record. -/
structure IntentRecord where
  /-- Stable key. Declaration names derive from it. -/
  key : String
  /-- The ledger every atom is over. -/
  ledger : String
  /-- Its atoms, in surface order; the sentence is their `and`-join. -/
  atoms : List String
  /-- Every §13 atom this record sharpens. A ratifiable record names at least one; an
  adversarial record names none, because an adversarial verdict must never look like a
  claim about a reviewed requirement. -/
  specAtoms : List String
  /-- SHA-256 of the digested rule-unit body the named atoms share, empty when none. The
  gate recomputes it from the SPEC, so a prose change re-opens ratification. -/
  digest : String
  /-- The corpus unit whose controlled-language sentence one of this record's atoms is
  proved equal to, and that atom. This pair is what stops the two languages from drifting:
  the intent and the sentence are provably the same statement about the model. -/
  corpusUnit : Option String
  bridgedAtom : Option String
  expected : Verdict
  note : String
  deriving Repr, Inhabited

/-! ## The atoms -/

def atoms : List IntentAtom :=
  [ { key := "LEASE_EXPIRY_BOUND"
      ledger := "AgentCore.TurnLease"
      sentence :=
        "lease reclaims require the recorded expiry is at most the stated time \
         for the reclaim"
      polarity := .safety
      note :=
        "a platform may reclaim a lease only at or after the tick it recorded as the \
         lease's expiry. This is C13-TURN-LEASE-EXPIRY stated as a constraint on a \
         platform rather than as a theorem about the model" },
    { key := "LEASE_RECLAIM_POSSIBLE"
      ledger := "AgentCore.TurnLease"
      sentence := "lease reclaims are possible"
      polarity := .permission
      note :=
        "a platform must admit some reclaim. The controlled language has no form for \
         this, which is why a set of its sentences can never contradict itself: the \
         empty relation satisfies every one of them" },
    { key := "LEASE_RECLAIM_UNHELD"
      ledger := "AgentCore.TurnLease"
      sentence := "lease reclaims require an unheld lease"
      polarity := .safety
      note :=
        "a platform may reclaim only a lease nobody holds. The model demands the \
         opposite — LeaseStep.reclaim requires a holder — so this atom is satisfiable \
         but unrealisable, which is the OUTSIDE-MODEL case" },
    { key := "LEASE_RECLAIM_BY_TWO"
      ledger := "AgentCore.TurnLease"
      sentence := "lease reclaims require the stated time is at most two for the reclaim"
      polarity := .safety
      note := "a platform may not reclaim after tick two" },
    { key := "LEASE_RECLAIM_AT_THREE"
      ledger := "AgentCore.TurnLease"
      sentence :=
        "lease reclaims are possible where the stated time equals three for the reclaim"
      polarity := .permission
      note :=
        "a platform must admit a reclaim at tick three. Against the atom above, no \
         platform at all can do both, which is the INCONSISTENT case" } ]

def atomWithKey? (key : String) : Option IntentAtom :=
  atoms.find? (fun atom => atom.key == key)

/-- The record's sentence: its atoms joined by the intent-level `and`, in surface order. -/
def IntentRecord.sentence (record : IntentRecord) : Except String String := do
  let mut parts : List String := []
  for key in record.atoms do
    match atomWithKey? key with
    | none => throw s!"intent record '{record.key}' names no atom '{key}'"
    | some atom => parts := parts ++ [atom.sentence]
  if parts.isEmpty then throw s!"intent record '{record.key}' names no atom"
  return String.intercalate " and " parts

/-! ## The ratifiable records -/

/-- Every ratifiable record. A ratifiable record anchors §13 atoms and must come out
CONSISTENT: an intent the model cannot realise is not a requirement anybody can ratify, it
is a finding about the model, and `SpecCnl.Divergence` is where a finding goes. -/
def units : List IntentRecord :=
  [ { key := "INT_LEASE_RECLAIM"
      ledger := "AgentCore.TurnLease"
      atoms := ["LEASE_EXPIRY_BOUND", "LEASE_RECLAIM_POSSIBLE"]
      specAtoms := ["C13-TURN-LEASE-EXPIRY"]
      digest := "345c281041a50e304408102fe36242689c57f2b428dcc01eda7bbaf12e27ae03"
      corpusUnit := some "C13_TURN_LEASE_EXPIRY"
      bridgedAtom := some "LEASE_EXPIRY_BOUND"
      expected := .consistent
      note :=
        "the expiry rule together with the demand that reclaim be possible at all. The \
         safety half alone is satisfied by a platform that never reclaims, so the \
         permission is what makes the pair say something a vacuous platform fails" } ]

def unitWithKey? (key : String) : Option IntentRecord :=
  units.find? (fun record => record.key == key)

/-! ## Derived declaration names

The same discipline as `SpecCnl.Corpus.RuleUnit`: a record owns its declarations by name,
so a declaration cannot exist without a record that owns it and a record cannot claim one
nothing audits. -/

def IntentAtom.denotation (atom : IntentAtom) : String :=
  s!"SpecCnl.Intent.Proofs.intent_{atom.key}"

def IntentAtom.polarityProof (atom : IntentAtom) : String :=
  s!"SpecCnl.Intent.Proofs.polar_{atom.key}"

def IntentAtom.auditedNames (atom : IntentAtom) : List String :=
  [atom.denotation, atom.polarityProof]

def IntentRecord.denotation (record : IntentRecord) : String :=
  s!"SpecCnl.Intent.Proofs.intent_{record.key}"

def IntentRecord.split (record : IntentRecord) : String :=
  s!"SpecCnl.Intent.Proofs.split_{record.key}"

def IntentRecord.splitProof (record : IntentRecord) : String :=
  s!"SpecCnl.Intent.Proofs.splits_{record.key}"

def IntentRecord.upwardProof (record : IntentRecord) : String :=
  s!"SpecCnl.Intent.Proofs.upward_{record.key}"

def IntentRecord.claim (record : IntentRecord) : String :=
  s!"SpecCnl.Intent.Proofs.claim_{record.key}"

def IntentRecord.verdictProof (record : IntentRecord) : String :=
  s!"SpecCnl.Intent.Proofs.verdict_{record.key}"

def IntentRecord.witnessProof (record : IntentRecord) : String :=
  s!"SpecCnl.Intent.Proofs.witnessed_{record.key}"

def IntentRecord.refutationProof (record : IntentRecord) : String :=
  s!"SpecCnl.Intent.Proofs.refuted_{record.key}"

def IntentRecord.atModelClaim (record : IntentRecord) : Option String :=
  record.bridgedAtom.map (fun atom => s!"SpecCnl.Intent.Proofs.atModel_{atom}")

def IntentRecord.bridge (record : IntentRecord) : Option String :=
  record.bridgedAtom.map (fun atom => s!"SpecCnl.Intent.Proofs.bridge_{atom}")

/-- The proofs the record's own verdict needs. This list is what "decided" means: the
checker returns UNPROVED when one of these is absent, whatever the search found. -/
def IntentRecord.evidenceNames (record : IntentRecord) : List String :=
  match record.expected with
  | .consistent => [record.witnessProof]
  | .inconsistent => [record.refutationProof]
  | .outsideModel => [record.witnessProof, record.refutationProof]
  | .unproved => []

/-- Every audited declaration of a record, in report order. -/
def IntentRecord.auditedNames (record : IntentRecord) : List String :=
  [record.denotation, record.split, record.splitProof, record.upwardProof, record.claim,
    record.verdictProof] ++ record.evidenceNames ++
    record.atModelClaim.toList ++ record.bridge.toList

/-! ## Structural refusals -/

/-- Structural refusals of the ratifiable corpus: a duplicate key, an atom it does not
name, a §13 atom claimed twice, a missing digest, a bridge that names an atom the record
does not carry, or a verdict other than CONSISTENT.

A ratifiable record expecting anything but CONSISTENT is refused here rather than reported,
because ratification is approval of a requirement: an intent the model refuses is a finding
about the model, not a requirement a maintainer can approve. -/
def corpusRefusals : List String := Id.run do
  let mut refusals : List String := []
  let mut keys : List String := []
  let mut claimed : List String := []
  for record in units do
    if keys.contains record.key then
      refusals := refusals ++ [s!"duplicate intent record key '{record.key}'"]
    keys := record.key :: keys
    match record.sentence with
    | .error message => refusals := refusals ++ [message]
    | .ok _ => pure ()
    for key in record.atoms do
      match atomWithKey? key with
      | none => pure ()
      | some atom =>
          if atom.ledger != record.ledger then
            refusals := refusals ++
              [s!"intent record '{record.key}' is over ledger '{record.ledger}' but its \
                  atom '{key}' is over '{atom.ledger}'"]
    if (ledgerWithKey? record.ledger).isNone then
      refusals := refusals ++
        [s!"intent record '{record.key}' names no registered ledger '{record.ledger}'"]
    if record.specAtoms.isEmpty then
      refusals := refusals ++
        [s!"ratifiable intent record '{record.key}' anchors no conformance atom; an intent \
            that sharpens nothing reviewed has no home in this corpus"]
    for atom in record.specAtoms do
      if claimed.contains atom then
        refusals := refusals ++
          [s!"conformance atom '{atom}' is claimed by more than one intent record"]
      claimed := atom :: claimed
    if record.digest.length != 64 ||
        !record.digest.all (fun c => c.isDigit || (c >= 'a' && c <= 'f')) then
      refusals := refusals ++
        [s!"intent record '{record.key}' digest is not a SHA-256 hex digest"]
    if record.expected != .consistent then
      refusals := refusals ++
        [s!"ratifiable intent record '{record.key}' expects {record.expected.render}; only \
            a CONSISTENT intent is a requirement a maintainer can approve"]
    match record.bridgedAtom with
    | none =>
        refusals := refusals ++
          [s!"ratifiable intent record '{record.key}' bridges no atom to the controlled \
              language; without one the two languages can drift"]
    | some bridged =>
        if !record.atoms.contains bridged then
          refusals := refusals ++
            [s!"intent record '{record.key}' bridges atom '{bridged}', which it does not \
                carry"]
        if record.corpusUnit.isNone then
          refusals := refusals ++
            [s!"intent record '{record.key}' bridges an atom but names no corpus unit"]
  return refusals

end SpecCnl.Intent
