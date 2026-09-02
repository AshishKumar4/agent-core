import SpecCnl.Negative

/-!
# Auth: hostile near-misses

Each sentence below is a real misreading of one of this group's own sentences, and each is
refused for the recorded reason. Three defects recur, because the §3.3/§3.4 vocabulary is
where they are easiest to make: dropping the lifter that ties a condition to a label
constructor, swapping a precondition for a postcondition, and pairing a condition with a
transition family over the *same* ledger but a *different* label family — the Grant plane
has three of those, so the last one is the mistake this group is most exposed to.
-/

namespace SpecCnl.Adversarial.Negatives.Auth

def cases : List Case :=
  [ { sentence := "admitted authority decision has effective authority"
      kind := .noReading
      reason := "a bare common noun in subject position. `admitted authority decision` is \
        a predicate on an authority input, not an input, so the determiner is not \
        optional even when the noun is a genuine restriction rather than a type name" },
    { sentence := "every role materialization requires attenuated guest grants"
      kind := .noReading
      reason := "a postcondition under `requires`. The guest-attenuation clause reads the \
        ledger *after* the materialization, which is what makes it a claim about the \
        Grants that were written; `requires` takes a condition on the source state and \
        label and cannot conclude anything about the successor" },
    { sentence := "every role materialization establishes a completed verification scheme"
      kind := .noReading
      reason := "the converse swap, on the same label family. The completed-scheme clause \
        is a precondition on the Membership being assigned, and reading it as something \
        the materialization establishes would turn the guest gate into a consequence of \
        passing it" },
    { sentence := "every role materialization maintains an advanced scope epoch"
      kind := .noReading
      reason := "`maintains` takes a two-state relation, and the epoch advance is a \
        postcondition that reads the Membership the label carries. A relation between the \
        states either side of the step cannot see which Scope was bumped, which is \
        exactly why the clause is a `PO` and not a `PR`" },
    { sentence := "every authority resolution establishes rule ordinal keyed grants"
      kind := .noReading
      reason := "the ledger agrees and the label family does not. Both the resolution \
        family and the materialization postcondition range over AgentCore.AuthorityLedger, \
        so nothing but the label type keeps a claim about materialized Grants off the \
        step that issues a Resolution" },
    { sentence := "every grant delegation establishes a contained allow"
      kind := .noReading
      reason := "an unlifted payload postcondition. `a contained allow` is indexed by the \
        GrantId the delegate label carries, and `establishes` needs a postcondition on \
        the label, so the delegate label match cannot be left implicit" },
    { sentence := "every authority resolution requires an exact facet binding"
      kind := .noReading
      reason := "the same defect on the source-state side of the same label family: the \
        exact-Facet clause is a condition on a Resolution, and `requires` needs one on \
        the AuthorityLabel" },
    { sentence :=
        "every role materialization requires a tenant qualified principal for the resolution"
      kind := .noReading
      reason := "the resolution lifter cannot scope a condition under a Membership. The \
        two §3.3 transition families share their ledger, so a rule about the Principal an \
        issued Resolution names is refused over the step that materializes a Role rather \
        than silently read as a rule about Memberships" },
    { sentence :=
        "every authority resolution requires the acting principal subject for the resolution"
      kind := .noReading
      reason := "a state-relative relation is not a condition. `the acting principal \
        subject` relates a ledger, a caller, and a subject; the resolution lifter wants a \
        condition on a ledger and a Resolution, and there is no coercion between the two" },
    { sentence :=
        "every authority resolution requires the stated deadline is at most the bounded window"
      kind := .noReading
      reason := "an unlifted quantity comparison. Comparing two quantities read off a \
        Resolution yields a condition on a Resolution, and `requires` needs one on the \
        AuthorityLabel, so the resolve label match is required here too" },
    { sentence :=
        "every mediated start establishes a current authority path for the started intent"
      kind := .noReading
      reason := "the recheck is a precondition of admission, not something admission \
        establishes. The started-intent lifter yields a source-state condition, and \
        `establishes` takes a postcondition; reading §3.4 rule 7's final comparison as a \
        consequence would make the gate vacuous" },
    { sentence :=
        "every stale mediated denial requires a matched denial for the denied receipt"
      kind := .noReading
      reason := "the converse swap on the second mediated label. The denied receipt is \
        written by the step, so the lifted clause is a postcondition; `requires` would be \
        asking for a receipt the step has not recorded yet" } ]

end SpecCnl.Adversarial.Negatives.Auth
