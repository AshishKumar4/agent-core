import Lean.Data.Json
import SpecCnl.Adversarial
import SpecCnl.Divergence

/-!
# The emitted ledger and the axiom report

Two outputs, both consumed by `scripts/quality/cnl.mjs`:

1. `#cnl_axiom_designations` prints `#print axioms` for every declaration the corpus
   registers. The list is *generated from the corpus*, so a unit cannot claim a bridge
   that nothing audits, and an audited declaration cannot exist without a unit that owns
   it.
2. `#cnl_ledger` prints one line of compact JSON describing the grammar, the lexicon, and
   every unit's admitted reading. The gate re-serialises it into
   `artifacts/cnl/ledger.json` and compares byte for byte, so the checked-in artifact is a
   reviewed snapshot of what Lean actually produced rather than a second source of truth.

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
      ("words", Json.num (tokenise entry.surface).length),
      ("kind", if isGrammarEntry entry then "grammar" else "content"),
      ("caveats", Json.arr ((entry.caveats.map (fun c => Json.str c.render)).toArray)),
      ("constants",
        Json.arr (((modelConstants entry.denotation).map Json.str).toArray)) ]

/-- Every head every admitted reading uses. -/
private def exercisedHeads : Except String (List String) := do
  let mut heads : List String := []
  for unit in Corpus.units do
    let admission ← compile lexicon unit.sentence
    for head in admission.heads do
      if !heads.contains head then heads := heads ++ [head]
  return heads

private def unitJson (unit : Corpus.RuleUnit) : Except String Json := do
  let admission ← compile lexicon unit.sentence
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
      ("handProposition", unit.handProposition),
      ("bridge", unit.bridge),
      ("discharge", unit.discharge) ]

/-- The ledger. Refuses rather than reports a partial result: a corpus or lexicon that
does not hold together produces an error, not a smaller ledger. -/
def ledger : Except String Json := do
  match Corpus.corpusRefusals ++ lexiconRefusals ++ Adversarial.negativeFailures ++
      Adversarial.admittedScrambles ++ Adversarial.roundTripFailures with
  | [] => pure ()
  | refusals => throw (String.intercalate "; " refusals)
  let units ← Corpus.units.mapM unitJson
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
          [ ("categoryAtoms", Json.num 8),
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
/-- Designates every registered declaration for the axiom report. -/
elab "#cnl_axiom_designations" : command => do
  for name in Corpus.allAuditedNames do
    elabCommand (← `(command| #print axioms $(mkIdent name.toName)))

open Elab Command in
/-- Prints the ledger as one line of compact JSON, or fails the elaboration. -/
elab "#cnl_ledger" : command => do
  match ledger with
  | .error message => throwError s!"controlled-language ledger refused: {message}"
  | .ok value => logInfo s!"cnl-ledger {value.compress}"

end SpecCnl.Report

#cnl_axiom_designations
#cnl_ledger
