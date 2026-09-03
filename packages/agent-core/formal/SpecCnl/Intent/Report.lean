import Lean.Data.Json
import SpecCnl.Intent.Check
import SpecCnl.Intent.Proofs
import SpecCnl.Report

/-!
# The emitted intent ledger and the axiom report

Three outputs, all consumed by `scripts/quality/intents.mjs`:

1. `#intent_assert_shapes` refuses unless every record's declarations exist with exactly the
   expected types. This is the check that makes a verdict mean anything: without it
   `verdict_X` could inhabit a claim about another record, or a claim that says nothing.
2. `#intent_axiom_designations` prints `#print axioms` for every declaration the corpus
   registers. The list is generated from the records, the atoms and the connective tables,
   so a record cannot claim a proof nothing audits and an audited declaration cannot exist
   without a record that owns it.
3. `#intent_ledger` prints one line of compact JSON with every pinned input: the sentences,
   the reading keys, the emitted terms, the heads with their denotation text, the ledger
   binding, the polarity of every atom with the theorem that proves it, the verdict with its
   bounds and its witness, refutation and minimal core, and the actual rendered type of
   every declaration.

Lean owns the content; the gate owns the presentation and the checks Lean cannot make. It
adds exactly three things: the SHA-256 digests of denotation text and of SPEC prose, the
`normative.lock` digest of every model constant named, and the byte comparison against the
approved snapshot. Nothing there re-parses a sentence or re-decides a verdict.
-/

namespace SpecCnl.Intent.Report

open Lean

/-! ## Declaration shapes

A canonical rendering of the type shapes an intent declaration may have. Deliberately not a
pretty-printer, for the same reason `SpecCnl.Report.renderTypeExpr` is not: this string is
compared for exact equality by a checker that has no Lean, and pretty-printing depends on
options and on open namespaces. It goes one application deeper than that renderer, because a
polarity claim is an application and a claim of the wrong polarity about the wrong atom has
to be distinguishable from the right one. -/

def renderShape : Nat → Expr → String
  | 0, _ => "deep"
  | fuel + 1, expr =>
      match expr with
      | .const name _ => s!"const:{name}"
      | .sort level => if level.isZero then "Prop" else "other"
      | .app fn arg => s!"app({renderShape fuel fn},{renderShape fuel arg})"
      | .forallE _ domain body _ =>
          s!"pi({renderShape fuel domain},{renderShape fuel body})"
      | _ => "other"

/-- The rendered type of a declaration, or `none` when it does not exist. -/
def shapeOf (env : Environment) (name : String) : Option String :=
  (env.find? name.toName).map (fun info => renderShape 24 info.type)

private def lts (state label : String) : String :=
  s!"app(app(const:SpecCnl.Intent.Lts,const:{state}),const:{label})"

private def polarityShape (polarity : Polarity) (state label denotation : String) : String :=
  let closure := match polarity with
    | .safety => "SpecCnl.Intent.Downward"
    | .permission => "SpecCnl.Intent.Upward"
  s!"app(app(app(const:{closure},const:{state}),const:{label}),const:{denotation})"

/-- What each declaration of an atom must be. -/
def atomShapes (atom : IntentAtom) : Except String (List (String × String)) := do
  let row ← match ledgerWithKey? atom.ledger with
    | some row => pure row
    | none => throw s!"atom '{atom.key}' names no registered ledger '{atom.ledger}'"
  return [ (atom.denotation, s!"pi({lts row.state row.label},Prop)"),
           (atom.polarityProof,
             polarityShape atom.polarity row.state row.label atom.denotation) ]

/-- What each declaration of a record must be. `verdict_X` inhabiting exactly `claim_X` is
the load-bearing one: `claim_X` is generated from the record's own expected verdict, so a
proof of anything else is refused here. -/
def recordShapes (record : IntentRecord) : Except String (List (String × String)) := do
  let row ← match ledgerWithKey? record.ledger with
    | some row => pure row
    | none => throw s!"record '{record.key}' names no registered ledger '{record.ledger}'"
  let bridge : List (String × String) :=
    match record.atModelClaim, record.bridge, record.corpusUnit with
    | some claim, some bridge, some unit =>
        [ (claim, "Prop"),
          (bridge, s!"app(app(const:Iff,const:{claim}),const:SpecCnl.Sentences.cnl_{unit})") ]
    | _, _, _ => []
  return [ (record.denotation, s!"pi({lts row.state row.label},Prop)"),
           (record.split, s!"app(app(const:SpecCnl.Intent.Split,const:{row.state}),\
             const:{row.label})"),
           (record.claim, "Prop"),
           (record.verdictProof, s!"const:{record.claim}") ] ++ bridge

/-- Every declaration whose shape is checked, with the shape it must have. -/
def expectedShapes : Except String (List (String × String)) := do
  let mut expected : List (String × String) := []
  for atom in atoms do
    expected := expected ++ (← atomShapes atom)
  for record in allRecords do
    expected := expected ++ (← recordShapes record)
  return expected

def shapeRefusals (env : Environment) : List String :=
  match expectedShapes with
  | .error message => [message]
  | .ok expected => Id.run do
      let mut refusals : List String := []
      for (name, shape) in expected do
        match shapeOf env name with
        | none => refusals := refusals ++ [s!"declaration {name} does not exist"]
        | some actual =>
            if actual != shape then
              refusals := refusals ++ [s!"{name} has type {actual}, not {shape}"]
      return refusals

/-! ## Verdicts

`decided` is the verdict the instrument stands behind, and it is UNPROVED unless three
things agree: the bounded search proposes a verdict, the record expects that verdict, and
every proof that verdict needs exists. UNPROVED is therefore never a claim; it is the
absence of one, which is why no record may expect it. -/

def decided (env : Environment) (record : IntentRecord) : Verdict :=
  match Search.observed record with
  | .error _ => .unproved
  | .ok found =>
      if found.verdict != record.expected then .unproved
      else if (record.evidenceNames ++ [record.verdictProof]).all
          (fun name => (env.find? name.toName).isSome) then found.verdict
      else .unproved

def verdictRefusals (env : Environment) : List String :=
  allRecords.filterMap (fun record =>
    let verdict := decided env record
    if verdict == record.expected then none
    else some
      s!"intent record '{record.key}' expects {record.expected.render} but the instrument \
         decides {verdict.render}")

/-! ## Audited declarations -/

/-- The lemmas the algorithm itself rests on, plus every polarity theorem the connective
tables name. Generated from the tables, so a table edit changes what is audited. -/
def lemmaNames : List String :=
  [ "SpecCnl.Intent.sat_iff_rmax",
    "SpecCnl.Intent.satAt_congr",
    "SpecCnl.Intent.rmax_refines_of_subset",
    "SpecCnl.Intent.not_permission_of_core" ] ++
    connectives.map Connective.polarityTheorem ++ conjunction.polarityTheorems

/-- Every declaration the axiom report designates. -/
def allAuditedNames : List String :=
  lemmaNames ++ atoms.flatMap IntentAtom.auditedNames ++
    allRecords.flatMap IntentRecord.auditedNames

/-! ## The ledger -/

private def boundJson (bound : Bound) : Json :=
  Json.mkObj [("field", bound.field), ("low", Json.num bound.low),
    ("high", Json.num bound.high)]

private def ledgerJson (ledger : Ledger) : Json :=
  Json.mkObj
    [ ("key", ledger.key),
      ("state", ledger.state),
      ("label", ledger.label),
      ("step", ledger.step),
      ("exec", ledger.exec),
      ("soundness", ledger.soundness),
      ("completeness", ledger.completeness),
      ("initial", match ledger.initial with | some name => Json.str name | none => Json.null),
      ("order", ledger.order),
      ("bounds", Json.arr ((ledger.bounds.map boundJson).toArray)) ]

private def entryJson (entry : LexEntry) : Json :=
  Json.mkObj
    [ ("id", entry.id),
      ("surface", entry.surface),
      ("category", entry.category),
      ("denotation", entry.denotation),
      ("constants",
        Json.arr (((SpecCnl.Report.modelConstants entry.denotation).map Json.str).toArray)) ]

private def connectiveJson (connective : Connective) : Json :=
  Json.mkObj
    [ ("entry", connective.entry),
      ("polarity", connective.polarity.render),
      ("polarityTheorem", connective.polarityTheorem) ]

private def declarationJson (env : Environment) (role name : String) : Json :=
  Json.mkObj
    [ ("role", role),
      ("name", name),
      ("type", match shapeOf env name with
        | some shape => Json.str shape
        | none => Json.null) ]

private def atomJson (env : Environment) (atom : IntentAtom) : Except String Json := do
  let admission ← compileIntent atom.sentence
  return Json.mkObj
    [ ("key", atom.key),
      ("ledger", atom.ledger),
      ("sentence", atom.sentence),
      ("polarity", atom.polarity.render),
      ("note", atom.note),
      ("category", admission.category),
      ("readingKey", admission.key),
      ("ast", admission.ast),
      ("lean", admission.lean),
      ("heads", Json.arr ((admission.heads.map Json.str).toArray)),
      ("declarations",
        Json.arr (((atom.auditedNames.zip ["denotation", "polarity"]).map
          (fun (name, role) => declarationJson env role name)).toArray)) ]

private def instanceJson (permission instance? : String) : Json :=
  Json.mkObj [("permission", permission), ("instance", instance?)]

private def recordRoles : List String :=
  ["denotation", "split", "splits", "upward", "claim", "verdict"]

private def recordJson (env : Environment) (record : IntentRecord) : Except String Json := do
  let sentence ← record.sentence
  let admission ← compileIntent sentence
  let row ← match ledgerWithKey? record.ledger with
    | some row => pure row
    | none => throw s!"record '{record.key}' names no registered ledger"
  let found ← Search.observed record
  let verdict := decided env record
  return Json.mkObj
    [ ("key", record.key),
      ("ledger", record.ledger),
      ("sentence", sentence),
      ("atoms", Json.arr ((record.atoms.map Json.str).toArray)),
      ("specAtoms", Json.arr ((record.specAtoms.map Json.str).toArray)),
      ("digest", record.digest),
      ("note", record.note),
      ("readingKey", admission.key),
      ("ast", admission.ast),
      ("lean", admission.lean),
      ("heads", Json.arr ((admission.heads.map Json.str).toArray)),
      ("expected", record.expected.render),
      ("verdict", verdict.render),
      ("corpusUnit", match record.corpusUnit with
        | some unit => Json.str s!"SpecCnl.Sentences.cnl_{unit}"
        | none => Json.null),
      ("bridgedAtom", match record.bridgedAtom with
        | some atom => Json.str atom
        | none => Json.null),
      ("order", row.order),
      ("bounds", Json.arr ((row.bounds.map boundJson).toArray)),
      ("explored", Json.num found.explored),
      ("witnesses",
        Json.arr ((found.witnesses.map (fun (key, shown) => instanceJson key shown)).toArray)),
      ("failedPermission", match found.failed with
        | some key => Json.str key
        | none => Json.null),
      ("core", Json.arr ((found.core.map Json.str).toArray)),
      ("excludedInstance", match found.excluded with
        | some shown => Json.str shown
        | none => Json.null),
      ("witnessProof", if record.evidenceNames.contains record.witnessProof then
          Json.str record.witnessProof else Json.null),
      ("refutationProof", if record.evidenceNames.contains record.refutationProof then
          Json.str record.refutationProof else Json.null),
      ("declarations",
        Json.arr ((((recordRoles.zip
          [record.denotation, record.split, record.splitProof, record.upwardProof,
            record.claim, record.verdictProof]).map
          (fun (role, name) => declarationJson env role name)) ++
          (record.atModelClaim.toList.map (declarationJson env "atModel")) ++
          (record.bridge.toList.map (declarationJson env "bridge")) ++
          (record.evidenceNames.map (declarationJson env "evidence"))).toArray)) ]

/-- Every head every admitted intent reading uses. -/
private def exercisedHeads : Except String (List String) := do
  let mut heads : List String := []
  for atom in atoms do
    let admission ← compileIntent atom.sentence
    for head in admission.heads do
      if !heads.contains head then heads := heads ++ [head]
  for record in allRecords do
    let admission ← compileIntent (← record.sentence)
    for head in admission.heads do
      if !heads.contains head then heads := heads ++ [head]
  return heads

/-- The ledger. Refuses rather than reports a partial result. -/
def ledger (env : Environment) : Except String Json := do
  match corpusRefusals ++ adversarialRefusals ++ lexiconRefusals ++ Search.probeRefusals ++
      Search.verdictRefusals ++ negativeFailures ++ admittedNegatives ++ admittedScrambles ++
      roundTripFailures ++ shapeRefusals env ++ verdictRefusals env with
  | [] => pure ()
  | refusals => throw (String.intercalate "; " refusals)
  let atomEntries ← atoms.mapM (atomJson env)
  let ratifiable ← units.mapM (recordJson env)
  let adversarial ← cases.mapM (recordJson env)
  let exercised ← exercisedHeads
  let unexercised := addedEntries.filter (fun entry => !exercised.contains entry.id)
  return Json.mkObj
    [ ("grammar",
        Json.mkObj
          [ ("categoryAtoms", Json.num 13),
            ("rules", Json.num 2),
            ("addedEntries", Json.num addedEntries.length),
            ("tableEntries", Json.num lexicon.length),
            ("connectives", Json.num connectives.length) ]),
      ("ledgers", Json.arr ((ledgers.map ledgerJson).toArray)),
      ("connectives", Json.arr ((connectives.map connectiveJson).toArray)),
      ("conjunction",
        Json.mkObj
          [ ("entry", conjunction.entry),
            ("polarityTheorems",
              Json.arr ((conjunction.polarityTheorems.map Json.str).toArray)) ]),
      ("entries", Json.arr ((addedEntries.map entryJson).toArray)),
      ("unexercisedEntries",
        Json.arr (((unexercised.map LexEntry.id).map Json.str).toArray)),
      ("atoms", Json.arr atomEntries.toArray),
      ("records", Json.arr ratifiable.toArray),
      ("adversarialRecords", Json.arr adversarial.toArray),
      ("auditedNames", Json.arr ((allAuditedNames.map Json.str).toArray)),
      ("lemmaNames", Json.arr ((lemmaNames.map Json.str).toArray)),
      ("adversarial",
        Json.mkObj
          [ ("negativeCases", Json.num negatives.length),
            ("negativeRefused",
              Json.num (negatives.length - negativeFailures.length)),
            ("ambiguityCases",
              Json.num (negatives.filter (fun case =>
                match case.kind with | .ambiguous _ => true | _ => false)).length),
            ("scrambles", Json.num allScrambles.length),
            ("scramblesAdmitted", Json.num admittedScrambles.length),
            ("roundTripExact",
              Json.num (allRecords.length - roundTripFailures.length)) ]),
      ("negativeCorpus",
        Json.arr ((negatives.map (fun case =>
          Json.mkObj
            [ ("sentence", case.sentence),
              ("kind", case.kind.render),
              ("reason", case.reason) ])).toArray)) ]

open Elab Command in
/-- Refuses the build unless every intent declaration has exactly its expected type. -/
elab "#intent_assert_shapes" : command => do
  match shapeRefusals (← getEnv) ++ verdictRefusals (← getEnv) with
  | [] => pure ()
  | refusals => throwError s!"intent declarations refused: {String.intercalate "; " refusals}"

open Elab Command in
/-- Designates every registered declaration for the axiom report. -/
elab "#intent_axiom_designations" : command => do
  for name in allAuditedNames do
    elabCommand (← `(command| #print axioms $(mkIdent name.toName)))

open Elab Command in
/-- Prints the ledger as one line of compact JSON, or fails the elaboration. -/
elab "#intent_ledger" : command => do
  match ledger (← getEnv) with
  | .error message => throwError s!"intent ledger refused: {message}"
  | .ok value => logInfo s!"intent-ledger {value.compress}"

end SpecCnl.Intent.Report

#intent_assert_shapes
#intent_axiom_designations
#intent_ledger
