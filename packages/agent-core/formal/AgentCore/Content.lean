import AgentCore.Model

/-!
# ContentStore custody (SPEC §8.2, C13-CONTENT-CUSTODY)

A ContentStore belongs to exactly one Tenant, and a `ContentRef` resolves only for a
caller whose authority reaches that Tenant — no cross-Tenant read without a Grant that
says so. A reference alone keeps nothing alive: every durable record that names a
`ContentRef` is a retained owner, collection offers only content no record owns, and
removing a record releases its ownership, so "retention and GC follow Tenant policy
over unowned content alone" and a record cannot outlive the bytes it names.

Two promises are proved here:

* **tenant-bound resolution.** A resolve step admits only the home Tenant the ref's
  own `tenant` field names, or a Tenant an explicit cross-Tenant grant names — never an
  arbitrary caller.
* **unowned-only collection, reachably.** At every reachable ledger state, a ref any
  record still owns has not been collected — `OwnedImpliesStored`, proved by induction
  over the step relation, not asserted as a side condition on `collect` alone.

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

/-- A ref any record still owns has not been collected — the constructive form of "a
    record cannot outlive the bytes it names." -/
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

/-- **"Owned implies stored" holds at every reachable state.** A record cannot outlive
    the bytes it names, along every trace from boot — not merely as a per-step side
    condition. -/
theorem reachable_owned_implies_stored {ledger} (reachable : ContentReachable ledger) :
    OwnedImpliesStored ledger := by
  induction reachable with
  | boot => exact boot_owned_implies_stored
  | step _ step ih => exact content_step_preserves_owned_implies_stored ih step

/-- **A collected-yet-owned ledger is unreachable.** The constructive refutation: no
    reachable ledger ever has a record owning a ref whose content is absent. -/
theorem collected_owned_content_is_unreachable {ledger ref record}
    (owns : ledger.owningRecords ref record) (collected : ledger.stored ref = false) :
    ¬ ContentReachable ledger := fun reachable => by
  have stored := reachable_owned_implies_stored reachable ref record owns
  rw [stored] at collected
  contradiction

end AgentCore
