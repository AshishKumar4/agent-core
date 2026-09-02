import SpecCnl.Sentences.FacetInstall

/-!
# FacetInstall: hand propositions and bridges

Each `hand_X` below is written from the rule unit against `AgentCore` directly. Four of
the five bridges are `Iff.rfl`: the grammar's composition of lexicon denotations is
definitionally the hand statement. `bridge_C13_FACET_SLOT_AUTHORITY` is a real proof,
because its subject noun denotes `fun _ => True` and the hand proposition carries no such
hypothesis — stripping it is the work, and it is visible here rather than hidden in a
denotation.
-/

namespace SpecCnl.Bridge

open AgentCore

/-! ## §1.4 `C13-FACET-REF-CANONICAL` -/

def hand_C13_FACET_REF_CANONICAL : Prop :=
  ∀ (separator : Char), separator = ':' →
    ∀ (packageOne packageTwo instanceOne instanceTwo : List Char),
      DelimiterFree separator packageOne → DelimiterFree separator packageTwo →
      pairKey separator packageOne instanceOne = pairKey separator packageTwo instanceTwo →
        packageOne = packageTwo ∧ instanceOne = instanceTwo

theorem bridge_C13_FACET_REF_CANONICAL :
    Sentences.cnl_C13_FACET_REF_CANONICAL ↔ hand_C13_FACET_REF_CANONICAL := Iff.rfl

/-! ## §4.2 `C13-FACET-SLOT-AUTHORITY` -/

def hand_C13_FACET_SLOT_AUTHORITY : Prop :=
  ∀ (authority : SlotContributeAuthority)
    (schemas : SchemaId → StructuralValue → Bool) (ledger after : SlotLedger)
    (entry : SlotEntry),
    AuthorizedSlotStep schemas authority ledger (SlotLabel.contribute entry) after →
      authority entry.slot entry.contributor = true

theorem bridge_C13_FACET_SLOT_AUTHORITY :
    Sentences.cnl_C13_FACET_SLOT_AUTHORITY ↔ hand_C13_FACET_SLOT_AUTHORITY := by
  unfold Sentences.cnl_C13_FACET_SLOT_AUTHORITY hand_C13_FACET_SLOT_AUTHORITY qEvery
  exact ⟨fun admitted authority => admitted authority trivial,
    fun admitted authority _ => admitted authority⟩

/-! ## §4.1 `C13-FACET-DISPOSAL` -/

def hand_C13_FACET_DISPOSAL : Prop :=
  ∀ (before : EnvironmentLedger) (label : EnvironmentLabel) (after : EnvironmentLedger),
    EnvironmentStep before label after →
      ∀ session record, before.sessions session = some record →
        record.phase = SessionPhase.closed → after.sessions session = some record

theorem bridge_C13_FACET_DISPOSAL :
    Sentences.cnl_C13_FACET_DISPOSAL ↔ hand_C13_FACET_DISPOSAL := Iff.rfl

/-! ## §4.1 `C13-FACET-INSTALL-VERIFICATION` -/

def hand_C13_FACET_INSTALL_VERIFICATION : Prop :=
  ((∀ (snapshot : PlacementSnapshot), snapshot.Valid →
      snapshot.manifest.contains snapshot.selected = true) ∧
    ∀ (snapshot : PlacementSnapshot), snapshot.Valid →
      snapshot.trust.contains snapshot.selected = true) ∧
  ∀ (before : SlotLedger) (label : SlotLabel) (after : SlotLedger),
    ((∃ entry, label = SlotLabel.contribute entry) ∧
      ∃ schemas, SlotStep schemas before label after) →
    ∀ entry, label = SlotLabel.contribute entry →
      ∃ declaration, before.slots entry.slot = some declaration

theorem bridge_C13_FACET_INSTALL_VERIFICATION :
    Sentences.cnl_C13_FACET_INSTALL_VERIFICATION ↔
      hand_C13_FACET_INSTALL_VERIFICATION := Iff.rfl

/-! ## §4.2 `C13-FACET-CONTRIBUTION-ATTRIBUTION` -/

def hand_C13_FACET_CONTRIBUTION_ATTRIBUTION : Prop :=
  ((∀ (before : SlotLedger) (label : SlotLabel) (after : SlotLedger),
      (∃ schemas, SlotStep schemas before label after) →
        before.OriginsUnique → after.OriginsUnique) ∧
    ∀ (before : SlotLedger) (label : SlotLabel) (after : SlotLedger),
      ((∃ entry, label = SlotLabel.contribute entry) ∧
        ∃ schemas, SlotStep schemas before label after) →
      ∀ entry, label = SlotLabel.contribute entry →
        ∀ stored, stored ∈ before.entries → stored.id ≠ entry.id) ∧
  ∀ (before : SlotLedger) (label : SlotLabel) (after : SlotLedger),
    ((∃ entry, label = SlotLabel.recontribute entry) ∧
      ∃ schemas, SlotStep schemas before label after) →
    after.entries = before.entries

theorem bridge_C13_FACET_CONTRIBUTION_ATTRIBUTION :
    Sentences.cnl_C13_FACET_CONTRIBUTION_ATTRIBUTION ↔
      hand_C13_FACET_CONTRIBUTION_ATTRIBUTION := Iff.rfl

end SpecCnl.Bridge
