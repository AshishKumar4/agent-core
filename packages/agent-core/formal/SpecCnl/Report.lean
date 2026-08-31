import Lean.Data.Json
import SpecCnl.Adversarial
import SpecCnl.Divergence

/-!
# The emitted ledger and the axiom report

Three outputs, all consumed by `scripts/quality/cnl.mjs`:

1. `#cnl_assert_shapes` refuses unless every unit's four declarations exist with exactly
   the expected types. This is the check that makes a bridge mean anything: without it
   `bridge_X` could be `True ↔ True` and still be audited, sorry-free, and reported. It
   runs during `lake build SpecCnl`, so a mis-shaped bridge fails the build.
2. `#cnl_axiom_designations` prints `#print axioms` for every declaration the corpus
   registers. The list is generated from the corpus, so a unit cannot claim a bridge that
   nothing audits, and an audited declaration cannot exist without a unit that owns it.
3. `#cnl_ledger` prints one line of compact JSON describing the grammar, the lexicon with
   its denotation sources, and every unit's admitted reading together with the *actual*
   rendered type of each of its declarations. The gate re-derives the expected type from
   the unit's own names and compares, so the shape claim is checked on both sides.

Lean owns the content; the gate owns the presentation and the checks. Nothing here parses,
counts, or decides anything a Lean function has not already decided.
-/

namespace SpecCnl.Report

open Lean

/-- The `AgentCore` constants a reviewed denotation names. This is a scan of the reviewed
text, so it reports what the entry *says*, which is what a reviewer diffs. Lean checks
that the text elaborates; this only records which model names it mentions. -/
def modelConstants (denotation : String) : List String := Id.run do
  let mut found : List String := []
  let mut current : String := ""
  for character in denotation.toList do
    if character.isAlphanum || character == '.' || character == '_' then
      current := current.push character
    else
      if current.startsWith "AgentCore." && !found.contains current then
        found := found ++ [current]
      current := ""
  if current.startsWith "AgentCore." && !found.contains current then
    found := found ++ [current]
  return found

private def isGrammarEntry (entry : LexEntry) : Bool :=
  (modelConstants entry.denotation).isEmpty

private def entryJson (entry : LexEntry) : Json :=
  Json.mkObj
    [ ("id", entry.id),
      ("surface", entry.surface),
      ("category", entry.category),
      ("denotation", entry.denotation),
      ("words", Json.num (tokenise entry.surface).length),
      ("kind", if isGrammarEntry entry then "grammar" else "content"),
      ("caveats", Json.arr ((entry.caveats.map (fun c => Json.str c.render)).toArray)),
      ("constants",
        Json.arr (((modelConstants entry.denotation).map Json.str).toArray)) ]

/-! ## Declaration shapes

A canonical rendering of the only type shapes a corpus declaration may have. It is
deliberately not a pretty-printer: pretty-printing depends on options and on `open`
namespaces, and this string is compared for exact equality by a checker that has no Lean.
Anything unexpected renders as `other`, which no expected shape ever equals. -/
partial def renderTypeExpr : Expr → String
  | .const name _ => s!"const:{name}"
  | .sort level => if level.isZero then "Prop" else "other"
  | .app (.app (.const name _) lhs) rhs =>
      if name == ``Iff then s!"Iff({renderTypeExpr lhs},{renderTypeExpr rhs})" else "other"
  | _ => "other"

/-- The rendered type of a declaration, or `none` when it does not exist. -/
def renderedType (env : Environment) (name : String) : Option String :=
  (env.find? name.toName).map (fun info => renderTypeExpr info.type)

/-- What each of a unit's four declarations must be. `cnl_X` and `hand_X` are propositions;
`bridge_X` relates exactly those two and nothing else; `proved_X` inhabits exactly
`hand_X`. A bridge against a different proposition, or a discharge of a different
statement, is refused here. -/
def shapeRefusals (env : Environment) : List String := Id.run do
  let mut refusals : List String := []
  for unit in Corpus.units do
    let expected :=
      [ (unit.proposition, "Prop"),
        (unit.handProposition, "Prop"),
        (unit.bridge, s!"Iff(const:{unit.proposition},const:{unit.handProposition})"),
        (unit.discharge, s!"const:{unit.handProposition}") ]
    for (name, shape) in expected do
      match renderedType env name with
      | none => refusals := refusals ++ [s!"{unit.key}: declaration {name} does not exist"]
      | some actual =>
          if actual != shape then
            refusals := refusals ++
              [s!"{unit.key}: {name} has type {actual}, not {shape}"]
  return refusals

private def unitJson (env : Environment) (unit : Corpus.RuleUnit) : Except String Json := do
  let admission ← compile lexicon unit.sentence
  let rendered (name : String) : Except String String :=
    match renderedType env name with
    | some shape => .ok shape
    | none => .error s!"declaration {name} does not exist"
  return Json.mkObj
    [ ("key", unit.key),
      ("atoms", Json.arr ((unit.atoms.map Json.str).toArray)),
      ("specSection", unit.specSection),
      ("anchor", unit.anchor),
      ("digest", unit.digest),
      ("sentence", unit.sentence),
      ("words", Json.num (tokenise unit.sentence).length),
      ("ast", admission.ast),
      ("lean", admission.lean),
      ("heads", Json.arr ((admission.heads.map Json.str).toArray)),
      ("dropped", Json.arr ((unit.dropped.map Json.str).toArray)),
      ("proposition", unit.proposition),
      ("propositionType", ← rendered unit.proposition),
      ("handProposition", unit.handProposition),
      ("handPropositionType", ← rendered unit.handProposition),
      ("bridge", unit.bridge),
      ("bridgeType", ← rendered unit.bridge),
      ("discharge", unit.discharge),
      ("dischargeType", ← rendered unit.discharge) ]

/-- Every head every admitted reading uses. -/
private def exercisedHeads : Except String (List String) := do
  let mut heads : List String := []
  for unit in Corpus.units do
    let admission ← compile lexicon unit.sentence
    for head in admission.heads do
      if !heads.contains head then heads := heads ++ [head]
  return heads

/-- The ledger. Refuses rather than reports a partial result: a corpus, lexicon,
adversarial corpus, or declaration shape that does not hold together produces an error,
not a smaller ledger. -/
def ledger (env : Environment) : Except String Json := do
  match Corpus.corpusRefusals ++ lexiconRefusals ++ Adversarial.negativeFailures ++
      Adversarial.admittedScrambles ++ Adversarial.roundTripFailures ++ shapeRefusals env with
  | [] => pure ()
  | refusals => throw (String.intercalate "; " refusals)
  let units ← Corpus.units.mapM (unitJson env)
  let exercised ← exercisedHeads
  let unexercised := lexicon.filter (fun entry => !exercised.contains entry.id)
  let contentEntries := lexicon.filter (fun entry => !isGrammarEntry entry)
  let multiword := lexicon.filter (fun entry => (tokenise entry.surface).length > 1)
  let constants := lexicon.flatMap (fun entry => modelConstants entry.denotation)
  let distinctConstants := constants.foldl
    (fun acc name => if acc.contains name then acc else acc ++ [name]) ([] : List String)
  return Json.mkObj
    [ ("grammar",
        Json.mkObj
          [ ("categoryAtoms", Json.num 11),
            ("rules", Json.num 2),
            ("entries", Json.num lexicon.length),
            ("grammarEntries", Json.num (lexicon.length - contentEntries.length)),
            ("contentEntries", Json.num contentEntries.length),
            ("multiwordEntries", Json.num multiword.length),
            ("modelConstants", Json.num distinctConstants.length) ]),
      ("lexicon", Json.arr ((lexicon.map entryJson).toArray)),
      ("unexercisedEntries",
        Json.arr (((unexercised.map LexEntry.id).map Json.str).toArray)),
      ("units", Json.arr units.toArray),
      ("auditedNames", Json.arr (((Corpus.allAuditedNames).map Json.str).toArray)),
      ("divergenceNames", Json.arr ((Corpus.divergenceNames.map Json.str).toArray)),
      ("adversarial",
        Json.mkObj
          [ ("negativeCases", Json.num Adversarial.cases.length),
            ("negativeRefused",
              Json.num (Adversarial.cases.length - Adversarial.negativeFailures.length)),
            ("ambiguityCases",
              Json.num (Adversarial.cases.filter (fun case =>
                match case.kind with | .ambiguous _ => true | _ => false)).length),
            ("scrambles", Json.num Adversarial.allScrambles.length),
            ("scramblesAdmitted", Json.num Adversarial.admittedScrambles.length),
            ("roundTripExact",
              Json.num (Corpus.units.length - Adversarial.roundTripFailures.length)) ]),
      ("negativeCorpus",
        Json.arr ((Adversarial.cases.map (fun case =>
          Json.mkObj
            [ ("sentence", case.sentence),
              ("kind", case.kind.render),
              ("reason", case.reason) ])).toArray)) ]

open Elab Command in
/-- Refuses the build unless every corpus declaration has exactly its expected type. -/
elab "#cnl_assert_shapes" : command => do
  match shapeRefusals (← getEnv) with
  | [] => pure ()
  | refusals =>
      throwError s!"controlled-language declaration shapes refused: \
        {String.intercalate "; " refusals}"

open Elab Command in
/-- Designates every registered declaration for the axiom report. -/
elab "#cnl_axiom_designations" : command => do
  for name in Corpus.allAuditedNames do
    elabCommand (← `(command| #print axioms $(mkIdent name.toName)))

open Elab Command in
/-- Prints the ledger as one line of compact JSON, or fails the elaboration. -/
elab "#cnl_ledger" : command => do
  match ledger (← getEnv) with
  | .error message => throwError s!"controlled-language ledger refused: {message}"
  | .ok value => logInfo s!"cnl-ledger {value.compress}"

end SpecCnl.Report

#cnl_assert_shapes
#cnl_axiom_designations
#cnl_ledger
