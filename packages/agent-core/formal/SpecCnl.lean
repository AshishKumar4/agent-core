import SpecCnl.Hostile
import SpecCnl.Report

/-!
# The controlled language for SPEC rule units

A Lean-owned, unambiguous controlled language and its bridge to the formal model. The
grammar is data here; there is no parser anywhere else, so there is nothing for a second
parser to drift from.

* `SpecCnl.Category` — the categorial types and the Lean type each denotes.
* `SpecCnl.Parse` — the chart, the typed controlled-language semantic AST, linearisation,
  and Lean emission. `compile` is the only admission path.
* `SpecCnl.Grammar` — the domain-free combinators.
* `SpecCnl.Lexicon` — the closed vocabulary, every entry exercised by the corpus.
* `SpecCnl.Corpus` — the reviewed input: one sentence per SPEC rule unit, with its digest,
  its dropped clauses, and the declarations derived from it.
* `SpecCnl.Elab` — glue from a corpus key to an elaborated `Prop`.
* `SpecCnl.Sentences` — one admitted proposition per unit.
* `SpecCnl.Bridge` — the hand propositions and kernel-checked bridges to them.
* `SpecCnl.Proofs` — what discharges every hand proposition, so a bridge cannot pass
  against a false statement of the model.
* `SpecCnl.Divergence` — the proved SPEC↔model divergence this instrument found, kept as
  a discriminating witness after the model was fixed.
* `SpecCnl.Adversarial` — the negative corpus and the scrambles.
* `SpecCnl.Hostile` — kernel-checked assertions that all of it refuses what it must.
* `SpecCnl.Report` — the emitted ledger and axiom designations, consumed by
  `scripts/quality/cnl.mjs`.

What this instrument is not: it does not read SPEC prose (0 of the surveyed rule units
parse as written), it makes no claim about unrestricted English, and no tool in it judges
whether a controlled sentence means what its rule unit means. The sentence is a reviewed
input; the corpus record's `dropped` list exists so a reviewer can answer that question.
-/
