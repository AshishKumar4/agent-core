import SpecCnl.Adversarial
import SpecCnl.Intent.Corpus
import SpecCnl.Intent.Lexicon

/-!
# The adversarial intent corpus

Two kinds of evidence, both kernel-checked, both fail the build when they stop being
adversarial.

**Adversarial records** carry an *expected verdict* rather than an anchored atom. They are
checked the way `SpecCnl.Adversarial.negativeFailures` checks a negative sentence: the
checker's own verdict is compared against the expectation, so a verdict that drifts — a
contradiction that stops being detected, a model refusal that turns into a witness — fails
the build instead of quietly changing the artifact.

One of them expects CONSISTENT. That is deliberate: a checker that answered INCONSISTENT to
everything adversarial would look identical in a green run, so the adversarial set has to
contain a case the checker must *not* refuse.

**Negative sentences** are refused by admission itself, and the recorded kind is compared
against the observed one, because "no reading" and "two readings" are opposite defects.
-/

namespace SpecCnl.Intent

/-! ## Adversarial records -/

/-- Every adversarial record. An adversarial record anchors no conformance atom and bridges
no corpus unit: an adversarial verdict must never be able to look like a claim about a
reviewed requirement. -/
def cases : List IntentRecord :=
  [ { key := "INT_ADV_UNHELD_RECLAIM"
      ledger := "AgentCore.TurnLease"
      atoms := ["LEASE_RECLAIM_POSSIBLE", "LEASE_RECLAIM_UNHELD"]
      specAtoms := []
      digest := ""
      corpusUnit := none
      bridgedAtom := none
      expected := .outsideModel
      note :=
        "demanding a reclaim while forbidding a held one. Nothing here contradicts \
         anything: a platform that reclaims unheld leases is perfectly conceivable, and \
         the universe pass witnesses one. The SPEC model is what refuses it, because \
         LeaseStep.reclaim demands a holder, so the refutation is an inversion on that \
         constructor rather than arithmetic" },
    { key := "INT_ADV_EARLY_LATE_RECLAIM"
      ledger := "AgentCore.TurnLease"
      atoms := ["LEASE_RECLAIM_BY_TWO", "LEASE_RECLAIM_AT_THREE"]
      specAtoms := []
      digest := ""
      corpusUnit := none
      bridgedAtom := none
      expected := .inconsistent
      note :=
        "forbidding a reclaim after tick two while demanding one at tick three. No \
         platform at all satisfies both, so the verdict is INCONSISTENT rather than \
         OUTSIDE-MODEL and the refutation never mentions the model" },
    { key := "INT_ADV_BOUNDED_RECLAIM"
      ledger := "AgentCore.TurnLease"
      atoms := ["LEASE_RECLAIM_POSSIBLE", "LEASE_RECLAIM_BY_TWO"]
      specAtoms := []
      digest := ""
      corpusUnit := none
      bridgedAtom := none
      expected := .consistent
      note :=
        "the discriminating case. A bound on when a reclaim may happen, together with the \
         demand that one happen, is satisfiable and the model realises it. A checker that \
         answered INCONSISTENT whenever a safety atom bounded a permission would pass \
         every other case in this list and fail this one" } ]

/-- Every reviewed record, ratifiable and adversarial. -/
def allRecords : List IntentRecord := units ++ cases

def recordWithKey? (key : String) : Option IntentRecord :=
  allRecords.find? (fun record => record.key == key)

/-! ## Negative sentences -/

/-- How intent admission actually refused a sentence, or `none` when a single reading of the
whole span is an intent. The kinds are the controlled language's own, and they mean the same
thing: this is the same chart and the same deduplication, read at a different target. -/
def observedKind (sentence : String) : Option Adversarial.Kind :=
  if (sentenceRefusal sentence).isSome then some .alphabet
  else
    match readingsWhere isIntentCat lexicon (tokenise sentence).toArray with
    | .error _ => some .noReading
    | .ok [] => some .noReading
    | .ok [_] => none
    | .ok found => some (.ambiguous found.length)

/-- The reviewed negative sentences. -/
def negatives : List Adversarial.Case :=
  [ { sentence :=
        "lease reclaims are possible and lease reclaims require an unheld lease and \
         lease reclaims are possible"
      kind := .ambiguous 2
      reason :=
        "three atoms joined by the ordinary coordinator associate two ways. Conjunction is \
         associative in meaning, which is exactly why the grammar must not silently \
         choose: a ratification pin names one reading key, and a later lexicon edit could \
         swap which of two equivalent trees that key belongs to. A record is two atoms \
         until an explicitly delimited three-atom form exists" },
    { sentence := "every lease reclaim require an unheld lease"
      kind := .noReading
      reason :=
        "`require` takes a guard, and `every lease reclaim` is a transition family whose \
         denotation names AgentCore.LeaseStep. Admitting this would let an intent quantify \
         over the model's own step relation instead of over the platform's, which is the \
         whole distinction between the two languages" },
    { sentence := "lease reclaims requires an unheld lease"
      kind := .noReading
      reason :=
        "the mirror image: the controlled language's `requires` takes a transition family, \
         and `lease reclaims` is a guard. One surface may not carry both categories, so \
         neither reading exists" },
    { sentence := "lease reclaims require lease reclaims"
      kind := .noReading
      reason :=
        "a guard is not a condition. `GD` is kept distinct from `ST` for the reason `PO` is \
         kept distinct from `TR`: letting a guard stand in for the condition it guards \
         would make `X requires X` a tautology the grammar admits" },
    { sentence := "lease reclaims require a host pass"
      kind := .noReading
      reason :=
        "well-formed English refused by the ontology. The guard ranges over TurnLease and \
         LeaseLabel; `a host pass` is a condition on DynamicDomain and IsolateLabel. The \
         category algebra refuses it rather than a check somebody remembered to write" },
    { sentence :=
        "lease reclaims are possible and every effect step maintains attempt immutability"
      kind := .noReading
      reason :=
        "an intent atom and a controlled-language sentence cannot be conjoined. The two \
         coordinators are different entries at different categories, so one sentence is \
         never half a claim about the model and half a constraint on a platform" },
    { sentence := "are possible"
      kind := .noReading
      reason :=
        "a permission with no guard says nothing about which transitions must exist. The \
         connective's guard slot is not optional" },
    { sentence := "lease reclaims are possible where the stated time equals three"
      kind := .noReading
      reason :=
        "the payload condition needs its lifter. `the stated time` is a quantity over a \
         Time, and only `for the reclaim` ties that Time to the reclaim label's own; \
         without it no condition on LeaseLabel exists. This is the same rule that keeps \
         every payload condition and its label match separately reviewed" } ]

/-! ## Failures

Each list below is empty in a healthy tree, and `SpecCnl.Intent.Hostile` fails the build if
one is not. -/

/-- Negative sentences whose refusal is absent or is not the recorded kind. -/
def negativeFailures : List String :=
  negatives.filterMap (fun case =>
    match observedKind case.sentence with
    | none => some s!"'{case.sentence}' was admitted; it must be refused as {case.kind.render}"
    | some observed =>
        if observed == case.kind then none
        else some
          s!"'{case.sentence}' was refused as {observed.render}, not {case.kind.render}")

/-- Negative sentences full admission let through. `observedKind` reads the chart alone, so
this also covers the refusals that happen after it: an inexact round trip, an unresolved
ledger, and a denotation that does not inhabit its category. -/
def admittedNegatives : List String :=
  negatives.filterMap (fun case =>
    if (compileIntent case.sentence).toOption.isSome then some case.sentence else none)

/-- Every adjacent transposition of every record sentence. -/
def allScrambles : List String :=
  allRecords.flatMap (fun record =>
    match record.sentence with
    | .ok sentence => Adversarial.scrambles sentence
    | .error _ => [])

/-- Scrambles admission let through. Every one is a defect: linearisation recomputes surface
order from each head's category, so an admitted scramble would mean the round trip is
echoing a string the parser would have taken in any order. -/
def admittedScrambles : List String :=
  allScrambles.filter (fun sentence => (compileIntent sentence).toOption.isSome)

/-- Record sentences whose single reading does not linearise back to the sentence. -/
def roundTripFailures : List String :=
  allRecords.filterMap (fun record =>
    match record.sentence with
    | .error message => some message
    | .ok sentence =>
        match readingsWhere isIntentCat lexicon (tokenise sentence).toArray with
        | .ok [item] =>
            match linearise lexicon item with
            | .ok words =>
                let rebuilt := String.intercalate " " words
                if rebuilt == sentence then none
                else some s!"'{sentence}' linearises as '{rebuilt}'"
            | .error message => some s!"'{sentence}' does not linearise: {message}"
        | _ => some s!"'{sentence}' does not have exactly one intent reading")

/-! ## Structural refusals across both lists -/

/-- Structural refusals the ratifiable corpus alone cannot see: a key used twice across the
two lists, two records that are the same intent under two names, an adversarial record that
anchors a conformance atom or bridges a corpus unit, and a record expecting UNPROVED. -/
def adversarialRefusals : List String := Id.run do
  let mut refusals : List String := []
  let mut keys : List String := []
  let mut readingKeys : List String := []
  for record in allRecords do
    if keys.contains record.key then
      refusals := refusals ++ [s!"duplicate intent record key '{record.key}'"]
    keys := record.key :: keys
    match record.sentence with
    | .error message => refusals := refusals ++ [message]
    | .ok sentence =>
        match compileIntent sentence with
        | .error message =>
            refusals := refusals ++ [s!"intent record '{record.key}': {message}"]
        | .ok admission =>
            if readingKeys.contains admission.key then
              refusals := refusals ++
                [s!"intent record '{record.key}' has the reading key of an earlier record; \
                    two names for one intent would pin the same reading twice"]
            readingKeys := admission.key :: readingKeys
    if record.expected == .unproved then
      refusals := refusals ++
        [s!"intent record '{record.key}' expects UNPROVED, which is the fall-through rather \
            than a verdict a record may claim"]
  for record in cases do
    if !record.specAtoms.isEmpty then
      refusals := refusals ++
        [s!"adversarial intent record '{record.key}' anchors conformance atoms; an \
            adversarial verdict must not be able to look like a claim about a reviewed \
            requirement"]
    if record.bridgedAtom.isSome || record.corpusUnit.isSome then
      refusals := refusals ++
        [s!"adversarial intent record '{record.key}' bridges the controlled language"]
    if !record.digest.isEmpty then
      refusals := refusals ++
        [s!"adversarial intent record '{record.key}' carries a rule-unit digest but anchors \
            no atom"]
  return refusals

end SpecCnl.Intent
