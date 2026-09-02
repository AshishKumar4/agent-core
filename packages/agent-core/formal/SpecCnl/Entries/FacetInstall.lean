import SpecCnl.Parse
import SpecCnl.Grammar

/-!
# FacetInstall vocabulary

One paradigm for the slot ledger — the transition family, one lifter for the `contribute`
label, and the conditions themselves — plus three subjects the group needs and the model
does not give a ledger for: the separator of a canonical two-segment key (`Char`), a
contribute-authority policy (`AgentCore.SlotContributeAuthority`, an abstract predicate
rather than a record), and a placement snapshot (`AgentCore.PlacementSnapshot`, a record
with no transitions).

`facet.ref.separator` is the one entry here whose denotation names no `AgentCore`
constant, so `SpecCnl.Report` classifies it as a grammar entry. It is not one: it carries
the domain fact that the canonical `FacetRef` separator is exactly `:`, and the claim
about the join it separates lives in `determines.the.segments.it.joins`, which does name
the model.
-/

namespace SpecCnl.Entries.FacetInstall

def entries : List LexEntry :=
  [ { id := "facet.ref.separator"
      surface := "facet ref separator"
      category := "CN[Char]"
      denotation := "fun separator => separator = ':'" },
    { id := "determines.the.segments.it.joins"
      surface := "determines the segments it joins"
      category := "NP[Char]\\S"
      denotation :=
        "fun separator => ∀ packageOne packageTwo instanceOne instanceTwo, " ++
        "AgentCore.DelimiterFree separator packageOne → " ++
        "AgentCore.DelimiterFree separator packageTwo → " ++
        "AgentCore.pairKey separator packageOne instanceOne = " ++
        "AgentCore.pairKey separator packageTwo instanceTwo → " ++
        "packageOne = packageTwo ∧ instanceOne = instanceTwo" },
    { id := "contribute.authority.policy"
      surface := "contribute authority policy"
      category := "CN[AgentCore.SlotContributeAuthority]"
      denotation := "fun _ => True"
      caveats := [.typeAsCommonNoun] },
    { id := "admits.its.landed.contributions"
      surface := "admits its landed contributions"
      category := "NP[AgentCore.SlotContributeAuthority]\\S"
      denotation :=
        "fun authority => ∀ schemas ledger after entry, " ++
        "AgentCore.AuthorizedSlotStep schemas authority ledger " ++
        "(AgentCore.SlotLabel.contribute entry) after → " ++
        "authority (AgentCore.SlotEntry.slot entry) " ++
        "(AgentCore.SlotEntry.contributor entry) = true" },
    { id := "valid.placement"
      surface := "valid placement"
      category := "CN[AgentCore.PlacementSnapshot]"
      denotation := "AgentCore.PlacementSnapshot.Valid" },
    { id := "is.declared.by.the.manifest"
      surface := "is declared by the manifest"
      category := "NP[AgentCore.PlacementSnapshot]\\S"
      denotation :=
        "fun snapshot => AgentCore.PlacementSet.contains " ++
        "(AgentCore.PlacementSnapshot.manifest snapshot) " ++
        "(AgentCore.PlacementSnapshot.selected snapshot) = true" },
    { id := "is.admitted.by.the.trust.set"
      surface := "is admitted by the trust set"
      category := "NP[AgentCore.PlacementSnapshot]\\S"
      denotation :=
        "fun snapshot => AgentCore.PlacementSet.contains " ++
        "(AgentCore.PlacementSnapshot.trust snapshot) " ++
        "(AgentCore.PlacementSnapshot.selected snapshot) = true" },
    { id := "every.slot.step"
      surface := "every slot step"
      category := "TR[AgentCore.SlotLedger,AgentCore.SlotLabel]"
      denotation :=
        "fun before label after => ∃ schemas, " ++
        "AgentCore.SlotStep schemas before label after" },
    { id := "unique.contribution.origins"
      surface := "unique contribution origins"
      category := "CN[AgentCore.SlotLedger]"
      denotation := "AgentCore.SlotLedger.OriginsUnique" },
    { id := "every.slot.contribution"
      surface := "every slot contribution"
      category := "TR[AgentCore.SlotLedger,AgentCore.SlotLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ entry, label = AgentCore.SlotLabel.contribute entry) ∧ " ++
        "∃ schemas, AgentCore.SlotStep schemas before label after" },
    { id := "every.slot.recontribution"
      surface := "every slot recontribution"
      category := "TR[AgentCore.SlotLedger,AgentCore.SlotLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ entry, label = AgentCore.SlotLabel.recontribute entry) ∧ " ++
        "∃ schemas, AgentCore.SlotStep schemas before label after" },
    { id := "for.the.contribution"
      surface := "for the contribution"
      category :=
        "ST[AgentCore.SlotLedger,AgentCore.SlotEntry]" ++
        "\\ST[AgentCore.SlotLedger,AgentCore.SlotLabel]"
      denotation :=
        "fun cond before label => ∀ entry, " ++
        "label = AgentCore.SlotLabel.contribute entry → cond before entry" },
    { id := "an.unclaimed.entry.id"
      surface := "an unclaimed entry id"
      category := "ST[AgentCore.SlotLedger,AgentCore.SlotEntry]"
      denotation :=
        "fun ledger entry => ∀ stored, " ++
        "stored ∈ AgentCore.SlotLedger.entries ledger → " ++
        "AgentCore.SlotEntry.id stored ≠ AgentCore.SlotEntry.id entry" },
    { id := "a.declared.slot"
      surface := "a declared slot"
      category := "ST[AgentCore.SlotLedger,AgentCore.SlotEntry]"
      denotation :=
        "fun ledger entry => ∃ declaration, " ++
        "AgentCore.SlotLedger.slots ledger (AgentCore.SlotEntry.slot entry) = " ++
        "some declaration" },
    { id := "stored.contribution.identity"
      surface := "stored contribution identity"
      category := "PR[AgentCore.SlotLedger]"
      denotation :=
        "fun before after => AgentCore.SlotLedger.entries after = " ++
        "AgentCore.SlotLedger.entries before" },
    { id := "disposed.facet.finality"
      surface := "disposed facet finality"
      category := "PR[AgentCore.EnvironmentLedger]"
      denotation :=
        "fun before after => ∀ session record, " ++
        "AgentCore.EnvironmentLedger.sessions before session = some record → " ++
        "AgentCore.SessionRecord.phase record = AgentCore.SessionPhase.closed → " ++
        "AgentCore.EnvironmentLedger.sessions after session = some record" } ]

end SpecCnl.Entries.FacetInstall
