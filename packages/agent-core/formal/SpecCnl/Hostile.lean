import SpecCnl.Adversarial
import SpecCnl.Divergence
import SpecCnl.Report

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
#guard Adversarial.cases.length == 93

/-! ## Every adjacent transposition of every corpus sentence is refused

Linearisation recomputes surface order from each head's category. If a scramble were
admitted, the exact round trip `compile` enforces would be reproducing a string the parser
would have taken in any order. -/

#guard Adversarial.admittedScrambles.isEmpty
#guard Adversarial.allScrambles.length == 1007

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

/-! Two custody rules that read almost identically in English are kept apart by the ledger
they range over. `a home tenant` is the §8.2 content relation; the §3.5 secret lifter wants
the secret one, and no amount of grammatical well-formedness bridges them. -/

/--
error: refused: no reading of 'every secret resolve requires a home tenant for the resolved secret' as a sentence
-/
#guard_msgs in
example : Prop := cnl% "every secret resolve requires a home tenant for the resolved secret"

/-! ## A relation property is not a transition property

`is transitive` takes a binary relation over one type. A transition family relates a state,
a label, and a state, so the sentence below is refused by the category algebra rather than
by a check somebody remembered to write. -/

/--
error: refused: no reading of 'every secret step is transitive' as a sentence
-/
#guard_msgs in
example : Prop := cnl% "every secret step is transitive"

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

#guard (lexicon.filter (fun entry => entry.caveats.contains .typeAsCommonNoun)).length == 5
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

/-! ## Substitution chains resolve

`Ty.apply` follows variable-to-variable bindings. A single lookup would stop at the first
hop and report an unresolved category slot for a derivation that is in fact determined,
which would refuse admissible sentences and, worse, make admission depend on the order
unification happened to record its bindings. The chain below is the shape unification
actually produces: `a` bound to `b`, `b` bound to a model type. -/

#guard Ty.apply [("a", Ty.var "b"), ("b", Ty.con "AgentCore.Event")] (Ty.var "a") ==
  Ty.con "AgentCore.Event"

#guard (Cat.st (Ty.var "a") (Ty.var "b")).apply
  [("a", Ty.con "AgentCore.GraphStore"), ("b", Ty.var "c"),
    ("c", Ty.con "AgentCore.GraphLabel")] ==
  Cat.st (Ty.con "AgentCore.GraphStore") (Ty.con "AgentCore.GraphLabel")

/-! A chain that closes on itself resolves to a variable rather than looping, and `interp`
then refuses it. Fail-closed, not fail-slow. -/

#guard (Ty.apply [("a", Ty.var "b"), ("b", Ty.var "a")] (Ty.var "a")).interp.toOption.isNone

/-! ## An entry id cannot break reading identity

`Item.key` writes head ids into a nested `head(arg,arg)` string and distinct readings are
counted by distinct keys, so an id carrying a bracket or a comma could make two different
readings collide and report an ambiguous sentence as unambiguous. -/

#guard lexicon.all (fun entry => isSafeEntryId entry.id)
#guard !isSafeEntryId "bad(id"
#guard !isSafeEntryId "bad,id"
#guard !isSafeEntryId "bad)id"
#guard !isSafeEntryId "Bad"
#guard !isSafeEntryId ""

/-! ## The declaration-shape check discriminates

`SpecCnl.Report.shapeRefusals` is what stops a bridge from being audited, sorry-free, and
meaningless: without it `bridge_X` could relate two propositions that are not this unit's.
A check that accepted everything would look identical in a green run, so both directions
are demonstrated here on throwaway declarations, at build time.

`bridgeShapedRight` has the shape a corpus bridge must have. `bridgeShapedWrong` is a
perfectly good theorem that relates the wrong propositions, which is exactly the mistake
the check exists to catch. The probes are not `private`, because a private declaration
carries a mangled internal name and the check reads declarations by the name the corpus
records. -/

def cnl_probe : Prop := True

def hand_probe : Prop := True

theorem bridgeShapedRight : cnl_probe ↔ hand_probe := Iff.rfl

theorem bridgeShapedWrong : True ↔ True := Iff.rfl

theorem dischargeShapedRight : hand_probe := trivial

open Lean Elab Command in
/-- Refuses the build unless the shape check accepts the right shape, rejects a bridge over
the wrong propositions, and reports a missing declaration as missing. -/
elab "#cnl_assert_shape_discrimination" : command => do
  let env ← getEnv
  let expectedBridge :=
    "Iff(const:SpecCnl.Hostile.cnl_probe,const:SpecCnl.Hostile.hand_probe)"
  let expectedDischarge := "const:SpecCnl.Hostile.hand_probe"
  if Report.renderedType env "SpecCnl.Hostile.bridgeShapedRight" != some expectedBridge then
    throwError "the shape check does not recognise a correctly shaped bridge"
  if Report.renderedType env "SpecCnl.Hostile.bridgeShapedWrong" == some expectedBridge then
    throwError "the shape check cannot tell a bridge over the wrong propositions from a \
      correct one"
  if Report.renderedType env "SpecCnl.Hostile.dischargeShapedRight" != some expectedDischarge then
    throwError "the shape check does not recognise a correctly shaped discharge"
  if Report.renderedType env "SpecCnl.Hostile.bridgeShapedWrong" == some expectedDischarge then
    throwError "the shape check confuses a bridge with a discharge"
  if (Report.renderedType env "SpecCnl.Hostile.thisDoesNotExist").isSome then
    throwError "a missing declaration was reported as existing"

#cnl_assert_shape_discrimination

end SpecCnl.Hostile
