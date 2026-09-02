/-!
# The negative-case record type

The shape of one hostile sentence and the refusal it must receive. It sits in its own
module for the same reason `SpecCnl.Unit` does: a negative-corpus section is written
against this type alone, and `SpecCnl.Adversarial` concatenates every section, so a
section cannot import the assembly back.

Namespace, not file: everything here is `SpecCnl.Adversarial`.
-/

namespace SpecCnl.Adversarial

/-- How a sentence must be refused. Distinguishing the kinds is the point: "no reading"
and "two readings" are opposite defects. -/
inductive Kind where
  /-- Outside the controlled alphabet. -/
  | alphabet
  /-- No reading of the whole span is a sentence. -/
  | noReading
  /-- More than one reading is, with this many distinct readings. -/
  | ambiguous (readings : Nat)
  deriving DecidableEq, Repr, Inhabited

def Kind.render : Kind → String
  | .alphabet => "alphabet"
  | .noReading => "no-reading"
  | .ambiguous readings => s!"ambiguous({readings})"

structure Case where
  sentence : String
  kind : Kind
  /-- Why this sentence must not be admitted. -/
  reason : String
  deriving Repr, Inhabited

end SpecCnl.Adversarial
