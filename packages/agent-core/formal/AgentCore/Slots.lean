import AgentCore.Model

/-!
# Contributions and slots (SPEC §4.2)

A Contribution is declared data targeting a Slot, and a conforming host materializes it
through the same paths it offers imperatively, so declared and programmatic behavior
cannot diverge. The ledger records contributions in arrival order — exactly what a
revision-ordered store retains — and three rules are normative:

1. **Declarations are immutable.** A slot name holds one declaration; redeclaring an
   occupied name rejects, identical reinstallation is a stored no-op.
2. **Origins are exclusive.** One `(slot, contributor, ordinal)` origin identifies one
   entry; a second entry under a stored origin — or a stored entry id — rejects, in
   whichever order the two arrive.
3. **Resolution is a function of declared data.** Resolving a slot presents every
   stored entry for it exactly once, ordered by `(ordinal, contributor)`; two ledgers
   holding the same entries in different arrival orders resolve identically.

Schemas are abstracted as an acceptance environment `SchemaId → StructuralValue → Bool`
supplied to the step relation; slot authority policy and concrete JSON-Schema
evaluation are outside this model.
-/

namespace AgentCore

structure SlotName where value : Nat deriving DecidableEq, Repr
structure SlotEntryId where value : Nat deriving DecidableEq, Repr
structure SchemaId where value : Nat deriving DecidableEq, Repr

structure SlotDeclaration where
  name : SlotName
  entrySchema : SchemaId
  deriving DecidableEq, Repr

structure SlotEntry where
  id : SlotEntryId
  slot : SlotName
  contributor : FacetId
  ordinal : Nat
  value : StructuralValue
  deriving DecidableEq, Repr

/-- The contribution origin: within one slot, one contributor owns one ordinal. -/
def SlotEntry.SameOrigin (left right : SlotEntry) : Prop :=
  left.slot = right.slot ∧ left.contributor = right.contributor ∧
    left.ordinal = right.ordinal

theorem SlotEntry.SameOrigin.symm {left right : SlotEntry}
    (origin : left.SameOrigin right) : right.SameOrigin left :=
  ⟨origin.1.symm, origin.2.1.symm, origin.2.2.symm⟩

instance (left right : SlotEntry) : Decidable (left.SameOrigin right) :=
  inferInstanceAs (Decidable (_ ∧ _ ∧ _))

structure SlotLedger where
  slots : SlotName → Option SlotDeclaration
  entries : List SlotEntry

instance : Inhabited SlotLedger where
  default := ⟨fun _ => none, []⟩

/-- Declared presentation order: ordinal first, contributor identity second. Pure
    declared data — the arrival position plays no part. -/
def slotEntryLe (left right : SlotEntry) : Bool :=
  decide (left.ordinal < right.ordinal ∨
    (left.ordinal = right.ordinal ∧ left.contributor.value ≤ right.contributor.value))

theorem slotEntryLe_trans (a b c : SlotEntry) (hab : slotEntryLe a b = true)
    (hbc : slotEntryLe b c = true) : slotEntryLe a c = true := by
  simp only [slotEntryLe, decide_eq_true_eq] at hab hbc ⊢
  omega

theorem slotEntryLe_total (a b : SlotEntry) : (slotEntryLe a b || slotEntryLe b a) = true := by
  simp only [slotEntryLe, Bool.or_eq_true, decide_eq_true_eq]
  omega

theorem slotEntryLe_antisymm_key {a b : SlotEntry} (hab : slotEntryLe a b = true)
    (hba : slotEntryLe b a = true) : a.ordinal = b.ordinal ∧ a.contributor = b.contributor := by
  simp only [slotEntryLe, decide_eq_true_eq] at hab hba
  have values : a.contributor.value = b.contributor.value := by omega
  have contributors : (⟨a.contributor.value⟩ : FacetId) = ⟨b.contributor.value⟩ := by
    rw [values]
  exact ⟨by omega, contributors⟩

/-- Slot resolution: every stored entry for the slot, in declared order. -/
def SlotLedger.resolve (ledger : SlotLedger) (slot : SlotName) : List SlotEntry :=
  (ledger.entries.filter fun entry => decide (entry.slot = slot)).mergeSort slotEntryLe

def SlotLedger.OriginsUnique (ledger : SlotLedger) : Prop :=
  ∀ left ∈ ledger.entries, ∀ right ∈ ledger.entries, left.SameOrigin right → left = right

def SlotLedger.EntriesConform (schemas : SchemaId → StructuralValue → Bool)
    (ledger : SlotLedger) : Prop :=
  ∀ entry ∈ ledger.entries, ∃ declaration,
    ledger.slots entry.slot = some declaration ∧
      schemas declaration.entrySchema entry.value = true

inductive SlotLabel where
  | installSlot (declaration : SlotDeclaration)
  | reinstallSlot (declaration : SlotDeclaration)
  | contribute (entry : SlotEntry)
  | recontribute (entry : SlotEntry)
  deriving DecidableEq, Repr

/-- Slot transitions.

* `installSlot` — a declaration claims a fresh name; an occupied name never re-installs.
* `reinstallSlot` — the stored no-op for an identical redeclaration.
* `contribute` — the guarded append: an installed declaration whose schema accepts the
  value, a fresh entry id, and a fresh origin. Arrival order is recorded as-is.
* `recontribute` — the stored no-op for an identical re-contribution. -/
inductive SlotStep (schemas : SchemaId → StructuralValue → Bool) :
    SlotLedger → SlotLabel → SlotLedger → Prop
  | installSlot {ledger : SlotLedger} {declaration : SlotDeclaration} :
      ledger.slots declaration.name = none →
      SlotStep schemas ledger (.installSlot declaration)
        { ledger with slots := tableSet ledger.slots declaration.name declaration }
  | reinstallSlot {ledger : SlotLedger} {declaration : SlotDeclaration} :
      ledger.slots declaration.name = some declaration →
      SlotStep schemas ledger (.reinstallSlot declaration) ledger
  | contribute {ledger : SlotLedger} {entry : SlotEntry} {declaration : SlotDeclaration} :
      ledger.slots entry.slot = some declaration →
      schemas declaration.entrySchema entry.value = true →
      (∀ stored ∈ ledger.entries, stored.id ≠ entry.id ∧ ¬ stored.SameOrigin entry) →
      SlotStep schemas ledger (.contribute entry)
        { ledger with entries := ledger.entries ++ [entry] }
  | recontribute {ledger : SlotLedger} {entry : SlotEntry} :
      entry ∈ ledger.entries →
      SlotStep schemas ledger (.recontribute entry) ledger

/-- **An occupied slot name never re-installs.** Whatever the incoming declaration —
    identical or conflicting — installation targets fresh names only, so a declaration
    collision rejects in every arrival order. -/
theorem occupied_slot_redeclaration_rejected {schemas} {ledger after : SlotLedger}
    {declaration existing : SlotDeclaration}
    (stored : ledger.slots declaration.name = some existing) :
    ¬ SlotStep schemas ledger (.installSlot declaration) after := by
  intro step
  cases step with
  | installSlot fresh => rw [stored] at fresh; contradiction

/-- **Reinstallation is a stored identity.** The no-op path exists only for the exact
    stored declaration and changes nothing. -/
theorem slot_reinstallation_is_stored_identity {schemas} {ledger after : SlotLedger}
    {declaration : SlotDeclaration}
    (step : SlotStep schemas ledger (.reinstallSlot declaration) after) :
    after = ledger ∧ ledger.slots declaration.name = some declaration := by
  cases step with
  | reinstallSlot stored => exact ⟨rfl, stored⟩

/-- **Installed declarations are immutable.** No transition replaces or removes a
    stored slot declaration. -/
theorem slot_step_preserves_declarations {schemas} {before after : SlotLedger} {label}
    {name : SlotName} {declaration : SlotDeclaration}
    (step : SlotStep schemas before label after)
    (stored : before.slots name = some declaration) :
    after.slots name = some declaration := by
  cases step with
  | installSlot fresh =>
      rename_i incoming
      by_cases same : name = incoming.name
      · rw [same] at stored; rw [stored] at fresh; contradiction
      · change tableSet before.slots incoming.name incoming name = some declaration
        rw [tableSet_other before.slots incoming.name name same]
        exact stored
  | reinstallSlot _ => exact stored
  | contribute _ _ _ => exact stored
  | recontribute _ => exact stored

/-- **A contribution needs its installed slot.** -/
theorem uninstalled_slot_contribution_rejected {schemas} {ledger after : SlotLedger}
    {entry : SlotEntry} (missing : ledger.slots entry.slot = none) :
    ¬ SlotStep schemas ledger (.contribute entry) after := by
  intro step
  cases step with
  | contribute lookup _ _ => rw [missing] at lookup; contradiction

/-- **A contribution the entry schema rejects never lands.** -/
theorem nonvalidating_contribution_rejected {schemas} {ledger after : SlotLedger}
    {entry : SlotEntry} {declaration : SlotDeclaration}
    (stored : ledger.slots entry.slot = some declaration)
    (invalid : schemas declaration.entrySchema entry.value = false) :
    ¬ SlotStep schemas ledger (.contribute entry) after := by
  intro step
  cases step with
  | contribute lookup accepted _ =>
      rw [stored] at lookup
      cases Option.some.inj lookup
      rw [invalid] at accepted
      contradiction

/-- **A stored origin is exclusive.** Any stored entry sharing the candidate's
    `(slot, contributor, ordinal)` origin rejects the contribution, so whichever of two
    same-origin contributions arrives first, the later one rejects. -/
theorem conflicting_origin_contribution_rejected {schemas} {ledger after : SlotLedger}
    {stored entry : SlotEntry} (member : stored ∈ ledger.entries)
    (origin : stored.SameOrigin entry) :
    ¬ SlotStep schemas ledger (.contribute entry) after := by
  intro step
  cases step with
  | contribute _ _ fresh => exact (fresh stored member).2 origin

/-- **A stored entry id is immutable.** Re-using a stored id — even for identical
    content — is not a contribution; the identical no-op is `recontribute`. -/
theorem entry_id_reuse_rejected {schemas} {ledger after : SlotLedger}
    {stored entry : SlotEntry} (member : stored ∈ ledger.entries)
    (sameId : stored.id = entry.id) :
    ¬ SlotStep schemas ledger (.contribute entry) after := by
  intro step
  cases step with
  | contribute _ _ fresh => exact (fresh stored member).1 sameId

/-- **Recontribution is a stored identity.** The no-op path exists only for an entry
    already stored and changes nothing. -/
theorem recontribution_is_stored_identity {schemas} {ledger after : SlotLedger}
    {entry : SlotEntry} (step : SlotStep schemas ledger (.recontribute entry) after) :
    after = ledger ∧ entry ∈ ledger.entries := by
  cases step with
  | recontribute member => exact ⟨rfl, member⟩

/-- **Origin exclusivity is preserved.** In every reachable ledger, two stored entries
    sharing an origin are the same entry. -/
theorem slot_step_preserves_origin_exclusivity {schemas} {before after : SlotLedger} {label}
    (origins : before.OriginsUnique) (step : SlotStep schemas before label after) :
    after.OriginsUnique := by
  cases step with
  | installSlot _ => exact origins
  | reinstallSlot _ => exact origins
  | contribute lookup accepted fresh =>
      intro left leftMember right rightMember sameOrigin
      rcases List.mem_append.mp leftMember with leftOld | leftNew
      · rcases List.mem_append.mp rightMember with rightOld | rightNew
        · exact origins left leftOld right rightOld sameOrigin
        · rw [List.mem_singleton.mp rightNew] at sameOrigin
          exact absurd sameOrigin (fresh left leftOld).2
      · rcases List.mem_append.mp rightMember with rightOld | rightNew
        · rw [List.mem_singleton.mp leftNew] at sameOrigin
          exact absurd sameOrigin.symm (fresh right rightOld).2
        · rw [List.mem_singleton.mp leftNew, List.mem_singleton.mp rightNew]
  | recontribute _ => exact origins

/-- **Stored entries stay schema-conformant.** Every stored entry keeps an installed
    declaration whose schema accepts its value — installation cannot orphan an entry
    because declarations are immutable and a contribution validates on entry. -/
theorem slot_step_preserves_entry_conformance {schemas} {before after : SlotLedger} {label}
    (conform : before.EntriesConform schemas) (step : SlotStep schemas before label after) :
    after.EntriesConform schemas := by
  cases step with
  | installSlot fresh =>
      rename_i incoming
      intro entry member
      obtain ⟨declaration, lookup, accepted⟩ := conform entry member
      refine ⟨declaration, ?_, accepted⟩
      by_cases same : entry.slot = incoming.name
      · rw [same] at lookup; rw [lookup] at fresh; contradiction
      · change tableSet before.slots incoming.name incoming entry.slot = some declaration
        rw [tableSet_other before.slots incoming.name entry.slot same]
        exact lookup
  | reinstallSlot _ => exact conform
  | contribute lookup accepted fresh =>
      intro entry member
      rcases List.mem_append.mp member with old | new
      · exact conform entry old
      · rw [List.mem_singleton.mp new]
        exact ⟨_, lookup, accepted⟩
  | recontribute _ => exact conform

private theorem pairwise_perm_eq {α : Type} {le : α → α → Bool} :
    ∀ {left right : List α},
      (∀ a ∈ left, ∀ b ∈ left, le a b = true → le b a = true → a = b) →
      left.Pairwise (fun a b => le a b = true) →
      right.Pairwise (fun a b => le a b = true) →
      left.Perm right → left = right
  | [], right, _, _, _, perm => by
      cases right with
      | nil => rfl
      | cons b tail =>
          have member : b ∈ ([] : List α) := perm.mem_iff.mpr (List.mem_cons_self b tail)
          exact absurd member (List.not_mem_nil b)
  | a :: leftTail, right, antisymm, sortedLeft, sortedRight, perm => by
      cases right with
      | nil =>
          have member : a ∈ ([] : List α) := perm.mem_iff.mp (List.mem_cons_self a leftTail)
          exact absurd member (List.not_mem_nil a)
      | cons b rightTail =>
          have heads : a = b := by
            by_cases equal : a = b
            · exact equal
            · have aMember : a ∈ rightTail := by
                rcases List.mem_cons.mp (perm.mem_iff.mp (List.mem_cons_self a leftTail)) with
                  head | tail
                · exact absurd head equal
                · exact tail
              have bMember : b ∈ leftTail := by
                rcases List.mem_cons.mp (perm.mem_iff.mpr (List.mem_cons_self b rightTail)) with
                  head | tail
                · exact absurd head.symm equal
                · exact tail
              have leftLe : le a b = true := (List.pairwise_cons.mp sortedLeft).1 b bMember
              have rightLe : le b a = true := (List.pairwise_cons.mp sortedRight).1 a aMember
              exact antisymm a (List.mem_cons_self a leftTail) b
                (List.mem_cons_of_mem a bMember) leftLe rightLe
          subst heads
          have tails := pairwise_perm_eq
            (fun x xMember y yMember =>
              antisymm x (List.mem_cons_of_mem a xMember) y (List.mem_cons_of_mem a yMember))
            (List.pairwise_cons.mp sortedLeft).2 (List.pairwise_cons.mp sortedRight).2
            perm.cons_inv
          rw [tails]

/-- **Resolution is complete and declared-ordered.** Resolving a slot presents every
    stored entry for it exactly once, sorted by `(ordinal, contributor)`. -/
theorem resolution_is_complete_and_declared_order (ledger : SlotLedger) (slot : SlotName) :
    (ledger.resolve slot).Perm (ledger.entries.filter fun entry => decide (entry.slot = slot)) ∧
      (ledger.resolve slot).Pairwise (fun a b => slotEntryLe a b = true) :=
  ⟨List.mergeSort_perm _ slotEntryLe,
    List.sorted_mergeSort slotEntryLe_trans slotEntryLe_total _⟩

/-- **Resolution ignores arrival order.** Two ledgers holding the same contributions —
    however their arrival orders differ — resolve every slot to the same sequence.
    Origin exclusivity supplies the antisymmetry: within one slot, distinct entries
    never share `(ordinal, contributor)`. -/
theorem resolution_ignores_arrival_order {left right : SlotLedger} {slot : SlotName}
    (origins : left.OriginsUnique) (perm : left.entries.Perm right.entries) :
    left.resolve slot = right.resolve slot := by
  have filterPerm : (left.entries.filter fun entry => decide (entry.slot = slot)).Perm
      (right.entries.filter fun entry => decide (entry.slot = slot)) := perm.filter _
  refine pairwise_perm_eq ?_
    (List.sorted_mergeSort slotEntryLe_trans slotEntryLe_total _)
    (List.sorted_mergeSort slotEntryLe_trans slotEntryLe_total _)
    (((List.mergeSort_perm _ slotEntryLe).trans filterPerm).trans
      (List.mergeSort_perm _ slotEntryLe).symm)
  intro a aMember b bMember leftLe rightLe
  have aFiltered := (List.mergeSort_perm _ slotEntryLe).mem_iff.mp aMember
  have bFiltered := (List.mergeSort_perm _ slotEntryLe).mem_iff.mp bMember
  obtain ⟨aStored, aSlot⟩ := List.mem_filter.mp aFiltered
  obtain ⟨bStored, bSlot⟩ := List.mem_filter.mp bFiltered
  have key := slotEntryLe_antisymm_key leftLe rightLe
  exact origins a aStored b bStored
    ⟨(of_decide_eq_true aSlot).trans (of_decide_eq_true bSlot).symm, key.2, key.1⟩

/-- **Declared data characterizes resolution uniquely.** Any declared-ordered
    presentation of exactly the stored entries for a slot is the resolution — there is
    no second admissible presentation. -/
theorem resolution_is_unique_declared_order {ledger : SlotLedger} {slot : SlotName}
    {presented : List SlotEntry}
    (origins : ledger.OriginsUnique)
    (perm : presented.Perm (ledger.entries.filter fun entry => decide (entry.slot = slot)))
    (sorted : presented.Pairwise (fun a b => slotEntryLe a b = true)) :
    ledger.resolve slot = presented := by
  refine pairwise_perm_eq ?_
    (List.sorted_mergeSort slotEntryLe_trans slotEntryLe_total _) sorted
    ((List.mergeSort_perm _ slotEntryLe).trans perm.symm)
  intro a aMember b bMember leftLe rightLe
  have aFiltered := (List.mergeSort_perm _ slotEntryLe).mem_iff.mp aMember
  have bFiltered := (List.mergeSort_perm _ slotEntryLe).mem_iff.mp bMember
  obtain ⟨aStored, aSlot⟩ := List.mem_filter.mp aFiltered
  obtain ⟨bStored, bSlot⟩ := List.mem_filter.mp bFiltered
  have key := slotEntryLe_antisymm_key leftLe rightLe
  exact origins a aStored b bStored
    ⟨(of_decide_eq_true aSlot).trans (of_decide_eq_true bSlot).symm, key.2, key.1⟩

/-- **Only stored, validating entries resolve.** Every resolved entry targets the
    queried slot, is stored, and validates against the installed declaration. -/
theorem resolved_entry_is_stored_and_validates {schemas} {ledger : SlotLedger}
    {slot : SlotName} {entry : SlotEntry}
    (conform : ledger.EntriesConform schemas) (member : entry ∈ ledger.resolve slot) :
    entry.slot = slot ∧ entry ∈ ledger.entries ∧
      ∃ declaration, ledger.slots slot = some declaration ∧
        schemas declaration.entrySchema entry.value = true := by
  have filtered := (List.mergeSort_perm _ slotEntryLe).mem_iff.mp member
  obtain ⟨stored, slotMatch⟩ := List.mem_filter.mp filtered
  have slotEq := of_decide_eq_true slotMatch
  obtain ⟨declaration, lookup, accepted⟩ := conform entry stored
  rw [slotEq] at lookup
  exact ⟨slotEq, stored, declaration, lookup, accepted⟩

/-! ## Slot contribute-authority (SPEC §4.2)

`SlotDeclaration.authority: SlotAuthorityPolicy` names who may contribute and who may
see entries; "the materializer (§9.3) rejects contributions that violate the slot's
contribute-authority." That gate was previously outside this model entirely — `contribute`
admitted any `(slot, contributor, ordinal)` whose schema validated, with no check on
*who* the contributor was. For most slots that is a shape-only concern, but for `prompt`
specifically the contribute-authority check is the prompt-injection admission gate: it
is the one place that decides whether content from an untrusted Facet can ever land in
what the model assembles as its own instructions.

`AuthorizedSlotStep` adds that gate on top of `SlotStep` without touching it — every
existing `SlotStep` theorem still holds unconditionally, since a `SlotStep` step is not
required to have originated from a policy-checked one. The contribute-authority policy
itself is abstracted as a `Bool` predicate over `(slot, contributor)`, matching how
`schemas` is abstracted elsewhere; the concrete default policy — "any installed Facet in
scope" — depends on Facet installation state this file does not model
(`NC-FACET-MANIFEST-RUNTIME`). -/

/-- Who may contribute to a slot: `authority slot contributor = true` exactly when that
    Facet's contribution to that slot is admitted. -/
abbrev SlotContributeAuthority := SlotName → FacetId → Bool

/-- A policy-gated slot step: identical to `SlotStep` for every label, except that a
    `contribute` step additionally requires the entry's own `(slot, contributor)` pair
    to be authority-admitted. -/
inductive AuthorizedSlotStep (schemas : SchemaId → StructuralValue → Bool)
    (authority : SlotContributeAuthority) :
    SlotLedger → SlotLabel → SlotLedger → Prop
  | step {ledger label after} :
      (∀ entry, label = .contribute entry → authority entry.slot entry.contributor = true) →
      SlotStep schemas ledger label after →
      AuthorizedSlotStep schemas authority ledger label after

/-- **A policy-gated step is a step.** The authority gate only narrows admission; it
    adds no transition `SlotStep` itself does not already admit. -/
theorem authorized_slot_step_is_slot_step {schemas authority ledger label after}
    (step : AuthorizedSlotStep schemas authority ledger label after) :
    SlotStep schemas ledger label after := by
  cases step with
  | step _ underlying => exact underlying

/-- **An unauthorized contributor's entry never lands.** If the contribute-authority
    policy does not admit an entry's `(slot, contributor)` pair, no policy-gated step
    contributes it — whatever its schema, origin, or id. Instantiated at the `prompt`
    slot, this is exactly the prompt-injection admission gate: a Facet the policy has
    not authorized to contribute to `prompt` can never get content into it through this
    relation. -/
theorem unauthorized_contributor_never_lands {schemas authority ledger after entry}
    (unauthorized : authority entry.slot entry.contributor = false) :
    ¬ AuthorizedSlotStep schemas authority ledger (.contribute entry) after := by
  intro step
  cases step with
  | step gate _ =>
      rw [gate entry rfl] at unauthorized
      contradiction

/-- **Authority admission is required, not merely sufficient.** Every policy-gated
    contribution carries a proof its own `(slot, contributor)` pair was admitted at the
    moment it landed. -/
theorem authorized_contribution_carries_admission {schemas authority ledger after entry}
    (step : AuthorizedSlotStep schemas authority ledger (.contribute entry) after) :
    authority entry.slot entry.contributor = true := by
  cases step with
  | step gate _ => exact gate entry rfl

/-- **Non-contribute transitions are ungated.** Installing, reinstalling, and
    recontributing carry no additional authority check beyond `SlotStep`'s own guards —
    the contribute-authority policy governs only who may add a new entry. -/
theorem non_contribute_step_needs_no_authority {schemas authority ledger label after}
    (notContribute : ∀ entry, label ≠ .contribute entry)
    (step : SlotStep schemas ledger label after) :
    AuthorizedSlotStep schemas authority ledger label after :=
  .step (fun entry labelEq => absurd labelEq (notContribute entry)) step

end AgentCore
