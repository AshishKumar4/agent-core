import SpecCnl.Negative

/-!
# TrustRoute: hostile near-misses

Six misreadings of this group's own five sentences: a missing lifter, a verb-phrase
conjunction, a post-state condition offered as a precondition, the wrong lifter of one
domain, the wrong ledger's lifter, and the three-clause associativity defect.
-/

namespace SpecCnl.Adversarial.Negatives.TrustRoute

def cases : List Case :=
  [ { sentence := "every subscription firing requires a channel derived admission"
      kind := .noReading
      reason := "an unlifted payload condition. `a channel derived admission` is a \
        relation over a Subscription and an Event, and `requires` needs a condition on \
        the RoutingLabel, so the firing label match cannot be left implicit — which is \
        why the lifter is a separate entry rather than a match inside the condition" },
    { sentence :=
        "every published event derives a non self tier from its provenance without a \
         lease token and has lease evidence for a self tier"
      kind := .noReading
      reason := "coordination at the wrong level, in the direction English invites. \
        Sentence-level `and` takes a sentence on each side, and `has lease evidence for a \
        self tier` is a verb phrase awaiting its subject. The grammar has no verb-phrase \
        coordinator, so sharing one subject across two clauses is refused rather than \
        silently read as the two-sentence conjunction the corpus sentence spells out" },
    { sentence :=
        "every route reservation requires an authority matched tenant relation \
         for the reservation"
      kind := .noReading
      reason := "a post-state condition offered as a precondition. The reservation record \
        exists only in the successor store, so `an authority matched tenant relation` is a \
        postcondition; `requires` takes a condition on the source state and label, and the \
        categories keep a claim about what a step establishes apart from a claim about \
        what it needs" },
    { sentence :=
        "every route projection establishes an exact authenticated reservation projection \
         for the reservation"
      kind := .noReading
      reason := "two lifters of one ledger are not interchangeable. `for the reservation` \
        scopes a ReservationId-indexed postcondition under a reserve label, and this \
        postcondition is indexed by the ProjectionId a project label carries, so the \
        model refuses a sentence whose English reads perfectly well" },
    { sentence := "every route reservation establishes a stable invocation for the firing"
      kind := .noReading
      reason := "the wrong ledger's lifter. `for the firing` scopes a routing-ledger \
        relation under a fire label; `a stable invocation` is an event-store postcondition \
        indexed by a ReservationId. §6.2's two planes read almost identically in English \
        and are kept apart by the ledger they range over" },
    { sentence :=
        "every published event derives a non self tier from its provenance without a \
         lease token and every published event has lease evidence for a self tier and \
         every published event derives a non self tier from its provenance without a \
         lease token"
      kind := .ambiguous 2
      reason := "the associativity defect on this group's only conjoined sentence. \
        Ordinary `and` is binary, so three clauses have a left and a right reading; the \
        grammar refuses both rather than choosing, and a unit that genuinely needs three \
        clauses uses the separately typed `and additionally` form" } ]

end SpecCnl.Adversarial.Negatives.TrustRoute
