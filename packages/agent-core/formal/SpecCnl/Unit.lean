/-!
# The corpus record type

The shape of one reviewed pairing, and the derivation of the four declaration names a
pairing owns. It sits in its own module so a corpus section can be written without
importing the assembled corpus: `SpecCnl.Corpus` imports every section and concatenates
them, and a section that imported the assembly back would be a cycle.

Namespace, not file, decides the name: everything here is `SpecCnl.Corpus`, exactly as
before this module existed, so no reader or checker sees a renamed declaration.
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

end SpecCnl.Corpus
