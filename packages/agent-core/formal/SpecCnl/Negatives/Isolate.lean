import SpecCnl.Negative

/-!
# Isolate: hostile near-misses

Each case is a real misreading of one of this group's own sentences. Two label
constructors of one domain and two domains of one group are the two ways to get an
isolate sentence nearly right, and the categories refuse both.
-/

namespace SpecCnl.Adversarial.Negatives.Isolate

def cases : List Case :=
  [ { sentence := "every isolate invocation requires a passed binding"
      kind := .noReading
      reason := "an unlifted payload condition on the invoke constructor. `a passed \
        binding` is a condition on a BindingId and `requires` needs one on the \
        IsolateLabel, so the invoke label match cannot be left implicit — the same rule \
        that makes `for the egress` a separate entry" },
    { sentence := "every isolate invocation requires a passed destination for the invocation"
      kind := .noReading
      reason := "two lifters of one domain are not interchangeable. `for the invocation` \
        scopes a condition on a Binding under the invoke constructor, while `a passed \
        destination` is a Binding-and-Destination relation the egress lifter wants; an \
        invocation names no destination, and the category algebra is what says so" },
    { sentence := "every isolate step requires only host passed capabilities"
      kind := .noReading
      reason := "a postcondition read as a precondition. `only host passed capabilities` \
        relates the table after a step to the table before it, so it is `PO`; `requires` \
        takes `ST`, which cannot see the successor state. The two share no category even \
        though the English reads either way" },
    { sentence := "every isolate step maintains binding backed actions"
      kind := .noReading
      reason := "`maintains` takes a two-state relation and `binding backed actions` is a \
        one-state invariant. Backing is a property of a single domain — its action log \
        against its own passed table — not a relation between the domains either side of \
        a step" },
    { sentence := "every isolate step establishes a committed head advance"
      kind := .noReading
      reason := "the two domains this group spans are kept apart by the model. `a \
        committed head advance` is a postcondition on a SlateLedger and a SlateLabel, \
        while the isolate family ranges over a DynamicDomain and an IsolateLabel; the \
        Slate record plane and the dynamic isolate are both §4.6 and are not one \
        transition system" },
    { sentence := "every slate step establishes committed version immutability"
      kind := .noReading
      reason := "the converse clash on the Slate plane. `establishes` takes a \
        postcondition on a state, a label, and a successor, and `committed version \
        immutability` is a two-state relation, so the immutability clause needs \
        `maintains` and cannot borrow the head-advance clause's connective" } ]

end SpecCnl.Adversarial.Negatives.Isolate
