import AgentCore.Model

/-!
# ContentStore custody (SPEC §8.2, C13-CONTENT-CUSTODY)

§8.2 states a universal: "every durable record that names a `ContentRef` is a retained
owner of that content." That claim has two independent halves, and this module proves
only one of them:

* **tenant-bound resolution** (fully modeled). A `ContentRef` resolves only for a
  caller whose authority reaches the owning Tenant — no cross-Tenant read without an
  explicit grant.
* **retention safety, conditional on registration** (the half proved here).
  `owningRecords` is a primitive relation a step can populate via `own`; nothing in
  this module derives it from what a concrete record type — a Turn result, a Receipt,
  a Slate — actually stores in its own fields. What is proved is: *given* an ownership
  edge exists, `OwnedImpliesStored` holds reachably — collection never fires while any
  record owns a ref, so a record already registered as an owner cannot be outrun by
  GC. This is genuinely useful (it is the "GC races collection against retention"
  safety property), but it is **not** a proof that every record naming a ref gets
  registered as an owner in the first place — that coverage half of §8.2's universal
  (call it "naming implies owning") is not modeled and is not claimed. Concretely: a
  record type that stores a `ContentRef` in its own data without ever taking an `own`
  step is representable in this model and is not excluded by anything proved here.

This narrowing is not academic. The spec's universal is reported false in the
implementation tree today — Turn results, Receipts, and Slates carry `ContentRef`s but
never call whatever retention-registration exists. That is an implementation-conformance
gap the formal package explicitly does not adjudicate
(`ASM-IMPLEMENTATION-REFINEMENT-SEPARATE`), but it is exactly why the coverage half of
this claim must not be allowed to sound proved when it is not: the boundary above states
precisely what is safe (retention-safety-once-registered) and precisely what remains an
open, unenforced obligation (registration-on-naming, per record type).

Exact resolution transport, ContentStore persistence/retention policy timing, and
`ContentRef` wire representation stay out of scope (`NC-CONTENTSTORE`).
-/

namespace AgentCore

structure ContentRef where
  tenant : TenantId
  id : Nat
  deriving DecidableEq, Repr

structure RecordId where value : Nat deriving DecidableEq, Repr

structure ContentLedger where
  stored : ContentRef → Bool
  owningRecords : ContentRef → RecordId → Prop
  crossTenantGrants : TenantId → ContentRef → Prop

def ContentLedger.boot : ContentLedger :=
  ⟨fun _ => false, fun _ _ => False, fun _ _ => False⟩

instance : Inhabited ContentLedger where default := .boot

/-- A ref any *registered* owner still owns has not been collected. This is the
    retention-safety half of §8.2's custody claim, not the coverage half: it says
    nothing about whether every record that names a ref becomes a registered owner. -/
def OwnedImpliesStored (ledger : ContentLedger) : Prop :=
  ∀ ref record, ledger.owningRecords ref record → ledger.stored ref = true

theorem boot_owned_implies_stored : OwnedImpliesStored .boot :=
  fun _ _ owns => False.elim owns

/-- Helper: a two-key mark, matching `mark`'s single-key form. -/
def mark2 [DecidableEq α] [DecidableEq β] (rel : α → β → Prop) (a : α) (b : β) :
    α → β → Prop :=
  fun candidateA candidateB => (candidateA = a ∧ candidateB = b) ∨ rel candidateA candidateB

inductive ContentLabel where
  | put (ref : ContentRef)
  | own (ref : ContentRef) (record : RecordId)
  | release (ref : ContentRef) (record : RecordId)
  | collect (ref : ContentRef)
  | grantCrossTenant (tenant : TenantId) (ref : ContentRef)
  | resolve (ref : ContentRef) (requester : TenantId)
  deriving DecidableEq, Repr

/-- Custody transitions.

* `put` — content lands under a fresh ref; the ref's own `tenant` field is its
  ContentStore's owning Tenant.
* `own` — a durable record retains ownership of already-stored content.
* `release` — a record stops naming a ref (edited or removed), clearing its edge.
* `collect` — GC of unowned content only: no record may currently own the ref.
* `grantCrossTenant` — the owning Tenant explicitly admits another Tenant to resolve.
* `resolve` — admitted only for the home Tenant or a Tenant an explicit grant names. -/
inductive ContentStep : ContentLedger → ContentLabel → ContentLedger → Prop
  | put {ledger ref} :
      ledger.stored ref = false →
      ContentStep ledger (.put ref)
        { ledger with stored := fun candidate => if candidate = ref then true else ledger.stored candidate }
  | own {ledger ref record} :
      ledger.stored ref = true →
      ContentStep ledger (.own ref record)
        { ledger with owningRecords := mark2 ledger.owningRecords ref record }
  | release {ledger ref record} :
      ledger.owningRecords ref record →
      ContentStep ledger (.release ref record)
        { ledger with owningRecords := fun candidateRef candidateRecord =>
            (candidateRef, candidateRecord) ≠ (ref, record) ∧ ledger.owningRecords candidateRef candidateRecord }
  | collect {ledger ref} :
      ledger.stored ref = true → (∀ record, ¬ ledger.owningRecords ref record) →
      ContentStep ledger (.collect ref)
        { ledger with stored := fun candidate => if candidate = ref then false else ledger.stored candidate }
  | grantCrossTenant {ledger tenant ref} :
      ContentStep ledger (.grantCrossTenant tenant ref)
        { ledger with crossTenantGrants := fun candidateTenant candidateRef =>
            (candidateTenant = tenant ∧ candidateRef = ref) ∨ ledger.crossTenantGrants candidateTenant candidateRef }
  | resolveHome {ledger ref} :
      ledger.stored ref = true →
      ContentStep ledger (.resolve ref ref.tenant) ledger
  | resolveGranted {ledger ref requester} :
      ledger.stored ref = true → ledger.crossTenantGrants requester ref →
      ContentStep ledger (.resolve ref requester) ledger

/-- **A resolve step is admitted only for the home Tenant or an explicitly granted
    one.** No arbitrary caller's Tenant admits a resolve step. -/
theorem content_resolution_requires_home_or_grant {ledger after ref requester}
    (step : ContentStep ledger (.resolve ref requester) after) :
    requester = ref.tenant ∨ ledger.crossTenantGrants requester ref := by
  cases step with
  | resolveHome _ => exact Or.inl rfl
  | resolveGranted _ granted => exact Or.inr granted

/-- **A foreign, ungranted Tenant's resolution is refused.** -/
theorem foreign_tenant_content_resolution_rejected {ledger after ref requester}
    (foreign : requester ≠ ref.tenant) (ungranted : ¬ ledger.crossTenantGrants requester ref) :
    ¬ ContentStep ledger (.resolve ref requester) after := by
  intro step
  rcases content_resolution_requires_home_or_grant step with home | granted
  · exact foreign home
  · exact ungranted granted

/-- **Resolution requires the content to exist.** A collected or never-`put` ref
    admits no resolve step, home Tenant or granted. -/
theorem missing_content_resolution_rejected {ledger after ref requester}
    (missing : ledger.stored ref = false) :
    ¬ ContentStep ledger (.resolve ref requester) after := by
  intro step
  cases step with
  | resolveHome stored => rw [stored] at missing; contradiction
  | resolveGranted stored _ => rw [stored] at missing; contradiction

/-- **Collection requires the ref to be currently unowned.** -/
theorem collect_requires_unowned {ledger after ref}
    (step : ContentStep ledger (.collect ref) after) :
    ledger.stored ref = true ∧ ∀ record, ¬ ledger.owningRecords ref record := by
  cases step with
  | collect stored unowned => exact ⟨stored, unowned⟩

/-- **An owned ref cannot be collected.** Whichever record owns it, no `collect` step
    for that ref is admitted while the ownership edge stands. -/
theorem owned_content_cannot_be_collected {ledger after ref record}
    (owns : ledger.owningRecords ref record) :
    ¬ ContentStep ledger (.collect ref) after := by
  intro step
  exact (collect_requires_unowned step).2 record owns

/-- **Every step preserves "owned implies stored."** `put` only turns absent content
    present; `own` requires the ref already stored; `release` only removes an
    ownership edge; `collect` clears `stored` only for a ref it has just shown is
    unowned, so the implication is vacuous there and untouched elsewhere;
    `grantCrossTenant` and `resolve` touch neither field. -/
theorem content_step_preserves_owned_implies_stored {ledger after label}
    (invariant : OwnedImpliesStored ledger) (step : ContentStep ledger label after) :
    OwnedImpliesStored after := by
  cases step with
  | put fresh =>
      rename_i ref
      intro candidate record owns
      have stored := invariant candidate record owns
      by_cases same : candidate = ref
      · simp [same]
      · simpa [same] using stored
  | own storedRef =>
      rename_i ref record
      intro candidateRef candidateRecord owns
      rcases owns with ⟨sameRef, sameRecord⟩ | owns
      · rw [sameRef]; exact storedRef
      · exact invariant candidateRef candidateRecord owns
  | release _ =>
      intro candidateRef candidateRecord owns
      exact invariant candidateRef candidateRecord owns.2
  | collect storedRef unowned =>
      rename_i ref
      intro candidate record owns
      have stored := invariant candidate record owns
      by_cases same : candidate = ref
      · subst same; exact absurd owns (unowned record)
      · simpa [same] using stored
  | grantCrossTenant =>
      intro candidateRef candidateRecord owns
      exact invariant candidateRef candidateRecord owns
  | resolveHome _ => exact invariant
  | resolveGranted _ _ => exact invariant

inductive ContentReachable : ContentLedger → Prop
  | boot : ContentReachable .boot
  | step {before label after} : ContentReachable before → ContentStep before label after →
      ContentReachable after

/-- **"Owned implies stored" holds at every reachable state.** A *registered* owner is
    never outrun by collection, along every trace from boot — not merely as a per-step
    side condition. Whether every record that names a ref becomes a registered owner
    in the first place is a separate, unmodeled question (see the module docstring). -/
theorem reachable_owned_implies_stored {ledger} (reachable : ContentReachable ledger) :
    OwnedImpliesStored ledger := by
  induction reachable with
  | boot => exact boot_owned_implies_stored
  | step _ step ih => exact content_step_preserves_owned_implies_stored ih step

/-- **A collected-yet-registered-owned ledger is unreachable.** The constructive
    refutation: no reachable ledger ever has a record whose ownership is registered
    for a ref whose content is absent. -/
theorem collected_owned_content_is_unreachable {ledger ref record}
    (owns : ledger.owningRecords ref record) (collected : ledger.stored ref = false) :
    ¬ ContentReachable ledger := fun reachable => by
  have stored := reachable_owned_implies_stored reachable ref record owns
  rw [stored] at collected
  contradiction

end AgentCore
