import SpecCnl.Unit

/-!
# FacetInstall: reviewed pairings for §1.4, §4.1, and §4.2

The rule units here are about how a Facet is named, installed, and held responsible for
what it contributes: the canonical serialized `FacetRef`, install-time verification of a
manifest against what the runtime provides, the contribute-authority gate on a slot, the
identity and exclusivity of a materialized `SlotEntry`, and the disposal of resolved
Facets.

The model these sentences range over has no Facet record. `AgentCore.FacetId` is an
opaque `Nat` wrapper with no serialized form, no manifest, no install transition, and no
live-or-disposed state; a Facet appears in the model only as the `contributor` field of a
`SlotEntry`, the `facet` field of a `Binding` or an `OperationId`, and the abstract
`SlotContributeAuthority` argument of `AgentCore.AuthorizedSlotStep`. Every sentence below
therefore carries a *consequence* of a rule unit at the record the model does have — a
slot ledger, a placement snapshot, an environment ledger, a composite key — and every
clause that needs the Facet record itself is dropped with that reason. Two systematic
omissions: nothing here claims any attribution field beyond `SlotEntry.contributor`
(there is no `PackagePin` on a materialized record), and nothing here claims a refusal
*path*, because the model states its gates as preconditions of the step that lands rather
than as errors returned to a caller.
-/

namespace SpecCnl.Corpus.Units.FacetInstall

def units : List RuleUnit :=
  [ { key := "C13_FACET_REF_CANONICAL"
      atoms := ["C13-FACET-REF-CANONICAL"]
      specSection := "1.4"
      anchor := "SPEC.md:140"
      digest := "6483b0a53128f733eb489d0b8722c689f2ecb02ffa0aae65f26ba2a5db4564e0"
      sentence := "every facet ref separator determines the segments it joins"
      dropped :=
        [ "'A FacetRef identifies a facet instance; a Binding names a Grant-backed \
           instance in one protection domain; a ResolvedFacet is the live capability \
           returned by resolution', and 'the order is always the same: identify, then \
           name, then resolve'. THE SENTENCE IS WEAKER THAN THE ATOM. The model has \
           neither a FacetRef nor a ResolvedFacet record — AgentCore.FacetId is an opaque \
           Nat wrapper and resolution returns an AgentCore.Resolution over an \
           InvocationHeader — so the three-role ordering has nothing to range over",
          "'each segment matches ^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$': the model has no \
           character-class validation of an identifier segment. \
           AgentCore.patternCharAllowed is the §3.4 Facet-pattern alphabet and admits the \
           colon itself, so it is not this charset. What the sentence carries is the \
           consequence the charset exists for, through AgentCore.DelimiterFree: a segment \
           that excludes the separator makes the canonical form determine its two segments",
          "'the first segment is the FacetPackageId of §4.1 (core, core.fs, acme.deploy) \
           and not a §3.2 Scope': the model has no FacetPackageId type to distinguish from \
           AgentCore.Scope, so the confusion this clause forbids is not representable",
          "'empty, noncanonical, or additionally separated forms reject rather than \
           normalize': the model has no parse or validation relation over a serialized \
           ref, so there is no rejection path to quantify over. \
           AgentCore.pair_key_not_injective is the model's statement of why an \
           additionally separated form cannot be read back, and it is an existential \
           counterexample rather than a refusal",
          "'It contains one and only one : separator' is carried only through its \
           consequence. The sentence says the canonical join determines its segments when \
           the package-id segment excludes the separator; it does not say that a second \
           separator is refused at the boundary, and the instance segment is not required \
           to be separator-free for the claim to hold" ] },
    { key := "C13_FACET_SLOT_AUTHORITY"
      atoms := ["C13-FACET-SLOT-AUTHORITY", "C13-FACET-SLOT-VISIBILITY"]
      specSection := "4.2"
      anchor := "SPEC.md:862"
      digest := "7846a60a94572f7be0919ae5a032d20ee5703054964467a08bd09bda571db2b5"
      sentence := "every contribute authority policy admits its landed contributions"
      dropped :=
        [ "'query MUST filter by the slot's visibility policy', which is \
           C13-FACET-SLOT-VISIBILITY. AgentCore.SlotLedger.resolve takes no viewer and the \
           model has no visibility policy at all, so resolution presents every stored \
           entry to every reader and the clause has nothing to range over. The atom is \
           claimed by this unit and dropped here rather than left unanchored",
          "'visibility = the same policy as direct reads (§3.4 rule 4)', for the same \
           reason",
          "'Core slots carry an implicit default policy: contribute = any installed Facet \
           in scope'. AgentCore.SlotContributeAuthority is abstracted as a predicate over \
           (slot, contributor) exactly as the schema environment is abstracted, and the \
           default policy depends on Facet installation state the model does not have, so \
           the sentence quantifies over every policy of that type instead of naming this \
           one",
          "'the materializer (§9.3) MUST reject contributions that violate the slot's \
           contribute-authority' is carried in its admission form rather than its refusal \
           form: the sentence says every landed contribution carries its policy's \
           admission, and AgentCore.unauthorized_contributor_never_lands is the \
           contrapositive refusal the model also proves",
          "the subject noun 'contribute authority policy' denotes fun _ => True and so \
           cannot refuse a wrong subject; the entry carries Caveat.typeAsCommonNoun and \
           the quantification is over every inhabitant of the type" ] },
    { key := "C13_FACET_DISPOSAL"
      atoms := ["C13-FACET-DISPOSAL"]
      specSection := "4.1"
      anchor := "SPEC.md:689"
      digest := "bd2248a783a025569369701efd8894c3ce37241bfad9b3cfaef075c4b64a6f4e"
      sentence := "every environment step maintains disposed facet finality"
      dropped :=
        [ "'Turns dispose resolved Facets on completion, failure, cancellation, \
           suspension, or authority loss'. THE SENTENCE IS WEAKER THAN THE ATOM. The model \
           has no Turn status and no facet-disposal transition, so no trigger for disposal \
           is statable. What the sentence carries is that disposal is permanent: no \
           transition of any kind revives a closed Session record, which is how the model \
           represents a disposed child Facet",
          "'Facet lifecycle hooks are idempotent from the caller's perspective': the model \
           has no facet lifecycle hook. AgentCore.slot_reinstallation_is_stored_identity \
           and AgentCore.recontribution_is_stored_identity are the model's declared-install \
           idempotence, and they are about slots rather than about a Facet's own hooks",
          "'Protected invocation requires an active, undisposed Facet whose Grant, \
           Binding, lease, and revocation state are valid per §3.4': the model's \
           counterpart is the environment use-admission gate, and it is already carried by \
           C13-ENVIRONMENT-STALE-SESSION and C13-ENVIRONMENT-TURN-OWNED. Repeating it here \
           would duplicate a claim rather than add one",
          "the model represents a disposed Facet observably — a closed Session record, no \
           session-visible file, no live exposure — and has no live Facet resource object, \
           so the sentence says nothing about disposal mechanics beyond those post-state \
           facts" ] },
    { key := "C13_FACET_INSTALL_VERIFICATION"
      atoms := ["C13-FACET-INSTALL-VERIFICATION"]
      specSection := "4.1"
      anchor := "SPEC.md:666"
      digest := "88f437d400f88e53bf2aecee9b654f0a4781d91335672af4b6290058116b380c"
      sentence :=
        "every valid placement is declared by the manifest and every valid placement is \
         admitted by the trust set and additionally every slot contribution requires a \
         declared slot for the contribution"
      dropped :=
        [ "'The host verifies at install time that the runtime provides every \
           implementation the manifest declares'. THE SENTENCE IS WEAKER THAN THE ATOM. \
           The model has no runtime-implementation table and no Facet install transition, \
           so the positive verification half is unrepresentable. Placement is the one place \
           the model checks a manifest against what is available, and that is what the \
           first two clauses carry",
          "'Placement uses the deterministic admissible-set rule in §9.2' is carried only \
           through its two containment consequences; the preference order dynamic, \
           provider, bundled is a property of AgentCore.choosePlacement that the sentence \
           does not state",
          "'refuses contributions the manifest does not declare' is rendered at the slot \
           declaration rather than at the Facet manifest: AgentCore.SlotDeclaration is the \
           only declaration a contribution is checked against, so the third clause says a \
           contribution needs its slot declared and not that the contributing Facet's own \
           manifest declared it",
          "the entry-schema half of that same gate — AgentCore.nonvalidating_contribution_\
           rejected — cannot be carried at all: the schema environment is a parameter of \
           AgentCore.SlotStep rather than a field of the ledger, so a condition on a source \
           state and a label has no way to read it",
          "'a manifest may exclude modes it will not accept': the sentence carries the \
           containment that makes an exclusion effective, not the permission to exclude" ] },
    { key := "C13_FACET_CONTRIBUTION_ATTRIBUTION"
      atoms := ["C13-FACET-CONTRIBUTION-ATTRIBUTION"]
      specSection := "4.2"
      anchor := "SPEC.md:885"
      digest := "1736f88628a9d33f16d9ef839064d89501ff47600d41618d3dfb3569f0f08415"
      sentence :=
        "every slot step preserves unique contribution origins and every slot contribution \
         requires an unclaimed entry id for the contribution and additionally every slot \
         recontribution maintains stored contribution identity"
      dropped :=
        [ "'Every record a contribution materializes into — SlotEntry, catalog entry, \
           derived Subscription, Surface registration, prompt section, ingress endpoint, \
           and merged settings fragment — carries the exact FacetRef of the Facet that \
           contributed it and the PackagePin of the release the contribution was read \
           from'. THE SENTENCE CARRIES NO ATTRIBUTION FIELD. AgentCore.SlotEntry carries a \
           contributor : FacetId and no PackagePin, and the model materializes none of the \
           other six record kinds, so what the sentence carries is the identity and \
           exclusivity half of the rule unit",
          "'A SlotEntry's identity is the digest of exactly its declared fields': \
           AgentCore.SlotEntryId is an opaque Nat with no digest function, so the sentence \
           carries the consequence — a stored id is never reachable again through a \
           contribution — rather than the derivation",
          "'a changed contribution supersedes its predecessor rather than accreting beside \
           it': the model has no supersede step. AgentCore.SlotStep refuses a same-origin \
           contribution outright, so the first clause carries no-accretion and says nothing \
           about replacement",
          "'Attribution is written in the same transaction as the record it attributes and \
           is immutable for that record's lifetime': the model has no transaction and no \
           attribution-mutation step",
          "'a materialized record carrying no attribution is invalid rather than \
           unattributed, and a host MUST refuse to materialize a contribution it cannot \
           attribute': AgentCore.SlotEntry.contributor is a required field, so an \
           unattributed entry is not representable and a rendering of this clause would be \
           true by construction and therefore vacuous",
          "'Attribution is what makes withdrawal exact (§4.1) — the withdrawal set is a \
           query over these fields' and 'lets a host answer, from records alone, which \
           Facet is responsible for any entry a Surface renders': the model has no \
           withdrawal query and no Surface",
          "the third clause is stated over the stored entry list rather than over the whole \
           ledger; AgentCore.recontribution_is_stored_identity is stronger and leaves the \
           ledger identical" ] } ]

end SpecCnl.Corpus.Units.FacetInstall
