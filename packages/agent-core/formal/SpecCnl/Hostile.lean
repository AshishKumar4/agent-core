import SpecCnl.Adversarial
import SpecCnl.Divergence

/-!
# Hostile assertions

Kernel-checked assertions that admission refuses what it must. Each `#guard` fails the
build, so these are not a report anybody has to read.

The `example` blocks below use `cnl%` rather than `cnl_unit%`, because their point is that
a sentence is *refused* at elaboration time. A refusal that only appeared in a report
could be reported and ignored; an elaboration error cannot be.
-/

namespace SpecCnl.Hostile

/-! ## The negative corpus refuses, and refuses for the recorded reason -/

#guard Adversarial.negativeFailures.isEmpty
#guard Adversarial.cases.length == 12

/-! ## Every adjacent transposition of every corpus sentence is refused

Linearisation recomputes surface order from each head's category. If a scramble were
admitted, the exact round trip `compile` enforces would be reproducing a string the parser
would have taken in any order. -/

#guard Adversarial.admittedScrambles.isEmpty
#guard Adversarial.allScrambles.length == 109

/-! ## Every admitted sentence linearises back to itself, exactly -/

#guard Adversarial.roundTripFailures.isEmpty

/-! ## The lexicon and the corpus hold together

An unexercised lexicon entry is a paradigm cell nobody demonstrated, so the reported
grammar would be larger than the grammar with evidence behind it. -/

#guard lexiconRefusals.isEmpty
#guard Corpus.corpusRefusals.isEmpty
#guard (lexicon.filter (fun entry =>
  !(Corpus.units.flatMap (fun unit =>
    match compile lexicon unit.sentence with
    | .ok admission => admission.heads
    | .error _ => [])).contains entry.id)).isEmpty

/-! ## Ambiguity is a hard error, not a first parse

A parser that returned its first reading could never report that a specification sentence
has two. Both cases below have exactly two readings and are refused. -/

#guard Adversarial.observedKind
  "every content resolve requires a home tenant or a granted tenant or a home tenant \
   for the resolved reference" == some (.ambiguous 2)

/--
error: refused: 'every content resolve requires a home tenant or a granted tenant or a home tenant for the resolved reference' has 2 readings: requires(for.the.resolved.reference(or.relation(or.relation(a.home.tenant : RE[AgentCore.ContentLedger,AgentCore.ContentRef,AgentCore.TenantId], a.granted.tenant : RE[AgentCore.ContentLedger,AgentCore.ContentRef,AgentCore.TenantId]) : RE[AgentCore.ContentLedger,AgentCore.ContentRef,AgentCore.TenantId], a.home.tenant : RE[AgentCore.ContentLedger,AgentCore.ContentRef,AgentCore.TenantId]) : RE[AgentCore.ContentLedger,AgentCore.ContentRef,AgentCore.TenantId]) : ST[AgentCore.ContentLedger,AgentCore.ContentLabel], every.content.resolve : TR[AgentCore.ContentLedger,AgentCore.ContentLabel]) : S | requires(for.the.resolved.reference(or.relation(a.home.tenant : RE[AgentCore.ContentLedger,AgentCore.ContentRef,AgentCore.TenantId], or.relation(a.granted.tenant : RE[AgentCore.ContentLedger,AgentCore.ContentRef,AgentCore.TenantId], a.home.tenant : RE[AgentCore.ContentLedger,AgentCore.ContentRef,AgentCore.TenantId]) : RE[AgentCore.ContentLedger,AgentCore.ContentRef,AgentCore.TenantId]) : RE[AgentCore.ContentLedger,AgentCore.ContentRef,AgentCore.TenantId]) : ST[AgentCore.ContentLedger,AgentCore.ContentLabel], every.content.resolve : TR[AgentCore.ContentLedger,AgentCore.ContentLabel]) : S
-/
#guard_msgs in
example : Prop :=
  cnl% "every content resolve requires a home tenant or a granted tenant or a home tenant \
        for the resolved reference"

/-! ## Out-of-grammar prose is refused, not approximated

The rule unit's own words are outside the lexicon. That is the honest outcome: this
instrument does not read the specification. -/

/--
error: refused: no reading of 'the canonical graph must have one root with zero parents' as a sentence
-/
#guard_msgs in
example : Prop := cnl% "the canonical graph must have one root with zero parents"

/-! ## The ontology refuses a grammatical sentence

`every lease reclaim requires an unheld branch for the appended commit` is well-formed
English. It is refused because the condition ranges over `GraphStore` and the transition
family over `TurnLease`. -/

/--
error: refused: no reading of 'every lease reclaim requires an unheld branch for the appended commit' as a sentence
-/
#guard_msgs in
example : Prop := cnl% "every lease reclaim requires an unheld branch for the appended commit"

/-! ## A wrong denotation is a Lean type error

Every head the grammar emits is ascribed the type its category interprets to, so a
mis-declared entry cannot elaborate. The ascription is visible in the emitted term. -/

private def emittedAncestry : Except String String := do
  let admission <- compile lexicon "ancestry depends only on the commits"
  return admission.lean

/-- The emitted term ascribes every head the type its category interprets to, which is
what turns a mis-declared lexicon entry into a Lean type error. -/
private theorem ancestry_is_ascribed : True := .intro

#guard (match emittedAncestry with
  | .ok lean => lean.contains "((AgentCore.Ancestor) : (AgentCore.GraphStore)"
  | .error _ => false)

/-! ## A type-as-common-noun entry carries no restriction

Three entries denote `fun _ => True`. They cannot refuse a wrong noun, and the ledger
declares them so rather than leaving the weakening implied. -/

#guard (lexicon.filter (fun entry => entry.caveats.contains .typeAsCommonNoun)).length == 3
#guard (lexicon.filter (fun entry =>
  entry.denotation == "fun _ => True" && !entry.caveats.contains .typeAsCommonNoun)).isEmpty

/-! ## An unknown corpus key is refused

`cnl_unit%` reads its sentence from the corpus, so a proposition that names no unit has no
sentence and no digest binding it to a rule unit. -/

/--
error: no corpus unit 'C13_NOT_A_UNIT'
-/
#guard_msgs in
example : Prop := cnl_unit% "C13_NOT_A_UNIT"

/-! ## The resolved divergence stays discriminating

`fix_is_strict` is the theorem that fails if the `SubjectVerified` premise is removed,
while `prefix_guest_verification_diverges` keeps holding. Naming both here means the pair
cannot be dropped without a visible diff. -/

#guard Corpus.divergenceNames.length == 4
#guard Corpus.divergenceNames.contains "SpecCnl.Divergence.fix_is_strict"
#guard Corpus.divergenceNames.contains "SpecCnl.Divergence.prefix_guest_verification_diverges"

end SpecCnl.Hostile
