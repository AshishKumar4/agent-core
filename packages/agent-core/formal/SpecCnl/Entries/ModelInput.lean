import SpecCnl.Parse
import SpecCnl.Grammar

/-!
# ModelInput: lexicon entries for §5.6

One entry, which is the whole point of the paradigm rule at the head of `SpecCnl.Lexicon`:
the §8.2 content plane already ships the resolve family (`every content resolve`) and the
lifter that scopes a ref-and-requester relation under the resolve constructor
(`for the resolved reference`), so a second rule about that ledger costs one condition and
no new paradigm.

`retained content` is a relation over the ref and the requester that constrains the ref
alone. That is deliberate and it is where the division of labour between this record and
`C13-CONTENT-RESOLUTION` lives: whether the caller may resolve is a fact about the
requester, and whether the content is still there is a fact about the ref. Reusing the
existing lifter keeps both clauses on one surface shape and keeps the sentences
distinguishable by their condition rather than by a second lifter for the same
constructor. The denotation is not `fun _ => True` and carries no caveat: it refuses a
resolve step over content the ledger does not store, which is exactly the discrimination
§5.6's retention-loss rule needs at this seam.
-/

namespace SpecCnl.Entries.ModelInput

def entries : List LexEntry :=
  [ { id := "input.retained.content"
      surface := "retained content"
      category := "RE[AgentCore.ContentLedger,AgentCore.ContentRef,AgentCore.TenantId]"
      denotation :=
        "fun ledger ref _ => AgentCore.ContentLedger.stored ledger ref = true" } ]

end SpecCnl.Entries.ModelInput
