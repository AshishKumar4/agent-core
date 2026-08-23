import AgentCore.Model

/-!
# SecretRef custody (SPEC §3.5)

A SecretRef `{ source, provider, id }` names a credential held in Tenant custody.
Configuration, manifests, and Blueprints carry SecretRefs, never raw credential values.
This is the boundary the ledger left silently unmapped: no earlier module gave §3.5's
own structure a claim or a non-claim. The rule proved here is custody, not process
isolation — §3.5 is explicit that "if plaintext is readable in an agent-visible
filesystem, the ref does not protect it" — that narrower filesystem-plane claim is
`AC-ENVIRONMENT-001`'s `CredentialIsolated`. What is provable in the abstract at this
layer:

* **exact custody.** A SecretRef resolves only inside the Tenant named by its `source`,
  and only for the exact Binding and target endpoint that Tenant recorded when it
  accepted the credential.
* **repointing invalidates.** Repointing an integration at a new endpoint bumps the
  custody generation; a resolution issued under the prior generation stops being
  current, so it cannot present the old credential at the new place.
* **carriers hold refs, never values.** A delegation, a guest Membership, and a
  cross-tenant reservation each carry a `SecretCarrier`, which is representable as
  either a ref or the raw value — so the invariant excludes something real — and at
  every reachable ledger state every stored carrier is a ref.

Process isolation for a resolved credential once it leaves custody stays a non-claim;
§3.5 states plainly that custody is not that guarantee.
-/

namespace AgentCore

structure SecretRef where
  source : TenantId
  provider : String
  id : Nat
  deriving DecidableEq, Repr

structure SecretEndpoint where value : Nat deriving DecidableEq, Repr

/-- The opaque credential value a SecretRef ultimately protects. Representable so the
    custody invariant excludes something real, not a shape that could never be written
    down in the first place. -/
structure SecretValue where value : Nat deriving DecidableEq, Repr

/-- What a delegation, guest Membership, or cross-tenant reservation may carry for a
    named secret. §3.5: "A delegation, a guest Membership, and a cross-tenant
    reservation each carry the ref and never the value" — `value` is the representable
    violation the reachability theorem below excludes. -/
inductive SecretCarrier where
  | ref (secret : SecretRef)
  | value (secret : SecretRef) (raw : SecretValue)
  deriving DecidableEq, Repr

def SecretCarrier.secret : SecretCarrier → SecretRef
  | .ref secret | .value secret _ => secret

/-- The Tenant-recorded custody: the exact Binding and target endpoint accepted for
    this secret, and the generation repointing bumps. -/
structure SecretCustody where
  binding : BindingId
  endpoint : SecretEndpoint
  generation : Nat
  deriving DecidableEq, Repr

/-- An issued resolution: the exact secret, Binding, and endpoint it was granted for,
    stamped with the custody generation live at issuance. -/
structure SecretResolution where
  id : ResolutionId
  secret : SecretRef
  binding : BindingId
  endpoint : SecretEndpoint
  generation : Nat
  deriving DecidableEq, Repr

structure DelegationId where value : Nat deriving DecidableEq, Repr
structure GuestGrantId where value : Nat deriving DecidableEq, Repr

structure SecretLedger where
  custody : SecretRef → Option SecretCustody
  resolutions : ResolutionId → Option SecretResolution
  delegations : DelegationId → Option SecretCarrier
  guestGrants : GuestGrantId → Option SecretCarrier
  crossTenantReservations : ReservationId → Option SecretCarrier

def SecretLedger.boot : SecretLedger :=
  ⟨fun _ => none, fun _ => none, fun _ => none, fun _ => none, fun _ => none⟩

instance : Inhabited SecretLedger where default := .boot

/-- A resolution is current exactly when the custody it was granted under is still the
    live custody record — same generation, same Binding, same endpoint. Repointing
    changes the generation, so a resolution issued before a repoint stops being current
    without needing to be revoked. -/
def SecretResolution.Current (ledger : SecretLedger) (resolution : SecretResolution) : Prop :=
  ledger.resolutions resolution.id = some resolution ∧
  ∃ custody, ledger.custody resolution.secret = some custody ∧
    custody.generation = resolution.generation ∧ custody.binding = resolution.binding ∧
    custody.endpoint = resolution.endpoint

inductive SecretLabel where
  | accept (secret : SecretRef) (binding : BindingId) (endpoint : SecretEndpoint)
  | repoint (secret : SecretRef) (binding : BindingId) (endpoint : SecretEndpoint)
  | resolve (id : ResolutionId) (secret : SecretRef) (requester : TenantId)
      (binding : BindingId) (endpoint : SecretEndpoint)
  | delegate (id : DelegationId) (secret : SecretRef)
  | guestGrant (id : GuestGrantId) (secret : SecretRef)
  | crossTenantReserve (id : ReservationId) (secret : SecretRef)
  deriving DecidableEq, Repr

/-- Custody transitions.

* `accept` — the Tenant records the first custody binding for a secret it has not seen.
* `repoint` — re-establishing the integration at a (possibly new) Binding and endpoint;
  the generation always advances, invalidating every resolution issued before it.
* `resolve` — admitted only for the requester named by the secret's own `source`, and
  only when the presented Binding and endpoint match the *current* custody exactly.
* `delegate` / `guestGrant` / `crossTenantReserve` — a carrier record is created; every
  constructor here builds it with `.ref`, never `.value`. -/
inductive SecretStep : SecretLedger → SecretLabel → SecretLedger → Prop
  | accept {ledger secret binding endpoint} :
      ledger.custody secret = none →
      SecretStep ledger (.accept secret binding endpoint)
        { ledger with custody := tableSet ledger.custody secret ⟨binding, endpoint, 0⟩ }
  | repoint {ledger secret binding endpoint current} :
      ledger.custody secret = some current →
      SecretStep ledger (.repoint secret binding endpoint)
        { ledger with custody := tableSet ledger.custody secret ⟨binding, endpoint, current.generation + 1⟩ }
  | resolve {ledger id secret requester binding endpoint current} :
      ledger.resolutions id = none →
      requester = secret.source →
      ledger.custody secret = some current →
      current.binding = binding → current.endpoint = endpoint →
      SecretStep ledger (.resolve id secret requester binding endpoint)
        { ledger with resolutions := tableSet ledger.resolutions id ⟨id, secret, binding, endpoint, current.generation⟩ }
  | delegate {ledger id secret} :
      ledger.delegations id = none →
      SecretStep ledger (.delegate id secret)
        { ledger with delegations := tableSet ledger.delegations id (.ref secret) }
  | guestGrant {ledger id secret} :
      ledger.guestGrants id = none →
      SecretStep ledger (.guestGrant id secret)
        { ledger with guestGrants := tableSet ledger.guestGrants id (.ref secret) }
  | crossTenantReserve {ledger id secret} :
      ledger.crossTenantReservations id = none →
      SecretStep ledger (.crossTenantReserve id secret)
        { ledger with crossTenantReservations := tableSet ledger.crossTenantReservations id (.ref secret) }

/-- **Resolution requires the exact home Tenant.** Only the Tenant a secret's `source`
    names can ever have its resolve step admitted. -/
theorem secret_resolution_requires_exact_tenant {ledger after id secret requester binding
    endpoint} (step : SecretStep ledger (.resolve id secret requester binding endpoint) after) :
    requester = secret.source := by
  cases step with
  | resolve _ home _ _ _ => exact home

/-- **A foreign requester's resolution is refused.** A Tenant other than the secret's
    `source` can never admit a resolve step for it, whatever Binding or endpoint it
    presents. -/
theorem foreign_tenant_secret_resolution_rejected {ledger after id secret requester binding
    endpoint} (foreign : requester ≠ secret.source) :
    ¬ SecretStep ledger (.resolve id secret requester binding endpoint) after :=
  fun step => foreign (secret_resolution_requires_exact_tenant step)

/-- **Resolution requires the exact current Binding and endpoint.** An admitted resolve
    step's Binding and endpoint are exactly the ones the current custody record holds —
    not any Binding or endpoint the secret was ever accepted for. -/
theorem secret_resolution_requires_current_custody {ledger after id secret requester binding
    endpoint} (step : SecretStep ledger (.resolve id secret requester binding endpoint) after) :
    ∃ current, ledger.custody secret = some current ∧
      current.binding = binding ∧ current.endpoint = endpoint ∧
      after.resolutions id = some ⟨id, secret, binding, endpoint, current.generation⟩ := by
  cases step with
  | resolve _ _ custody exactBinding exactEndpoint =>
      exact ⟨_, custody, exactBinding, exactEndpoint, tableSet_self ..⟩

/-- **A Binding or endpoint that does not match current custody is refused.** -/
theorem mismatched_custody_secret_resolution_rejected {ledger after id secret requester binding
    endpoint current} (lookup : ledger.custody secret = some current)
    (mismatched : current.binding ≠ binding ∨ current.endpoint ≠ endpoint) :
    ¬ SecretStep ledger (.resolve id secret requester binding endpoint) after := by
  intro step
  obtain ⟨found, foundLookup, exactBinding, exactEndpoint, _⟩ :=
    secret_resolution_requires_current_custody step
  rw [lookup] at foundLookup
  cases Option.some.inj foundLookup
  rcases mismatched with wrongBinding | wrongEndpoint
  · exact wrongBinding exactBinding
  · exact wrongEndpoint exactEndpoint

/-- **A newly issued resolution is current.** -/
theorem fresh_resolution_is_current {ledger after id secret requester binding endpoint current}
    (lookup : ledger.custody secret = some current)
    (step : SecretStep ledger (.resolve id secret requester binding endpoint) after) :
    SecretResolution.Current after ⟨id, secret, binding, endpoint, current.generation⟩ := by
  cases step with
  | resolve _ _ custody' exactBinding' exactEndpoint' =>
      rw [lookup] at custody'
      cases Option.some.inj custody'
      exact ⟨tableSet_self .., current, lookup, rfl, exactBinding', exactEndpoint'⟩

/-- **Repointing invalidates every resolution issued under the prior custody.** A
    resolution current before a `repoint` step is never current after it: the
    generation the step bumps no longer matches what the resolution was stamped with.
    Presenting the old credential resolution at the new endpoint fails, exactly as
    §3.5 requires — repointing does not carry the old grant forward. -/
theorem repoint_invalidates_prior_resolution {ledger after secret binding endpoint current
    resolution} (lookup : ledger.custody secret = some current)
    (step : SecretStep ledger (.repoint secret binding endpoint) after)
    (wasCurrent : SecretResolution.Current ledger resolution)
    (sameSecret : resolution.secret = secret) :
    ¬ SecretResolution.Current after resolution := by
  cases step with
  | repoint priorLookup =>
      rw [lookup] at priorLookup
      cases Option.some.inj priorLookup
      obtain ⟨_, priorCustody, priorLookup', priorGeneration, _, _⟩ := wasCurrent
      rw [sameSecret, lookup] at priorLookup'
      cases Option.some.inj priorLookup'
      rintro ⟨_, bumped, bumpedLookup, bumpedGeneration, _, _⟩
      rw [sameSecret] at bumpedLookup
      change tableSet ledger.custody secret ⟨binding, endpoint, current.generation + 1⟩ secret
        = some bumped at bumpedLookup
      rw [tableSet_self] at bumpedLookup
      cases Option.some.inj bumpedLookup
      dsimp only at bumpedGeneration
      rw [priorGeneration] at bumpedGeneration
      omega

/-- Every stored delegation, guest-grant, and cross-tenant-reservation carrier is a
    ref, never a raw value. -/
def CarrierRefOnly (ledger : SecretLedger) : Prop :=
  (∀ id secret raw, ledger.delegations id ≠ some (.value secret raw)) ∧
  (∀ id secret raw, ledger.guestGrants id ≠ some (.value secret raw)) ∧
  (∀ id secret raw, ledger.crossTenantReservations id ≠ some (.value secret raw))

theorem boot_carriers_ref_only : CarrierRefOnly .boot :=
  ⟨fun _ _ _ leak => (by cases leak), fun _ _ _ leak => (by cases leak),
    fun _ _ _ leak => (by cases leak)⟩

theorem secret_step_preserves_carrier_ref_only {before after label}
    (refOnly : CarrierRefOnly before) (step : SecretStep before label after) :
    CarrierRefOnly after := by
  obtain ⟨delegations, guestGrants, crossTenantReservations⟩ := refOnly
  cases step with
  | accept _ => exact ⟨delegations, guestGrants, crossTenantReservations⟩
  | repoint _ => exact ⟨delegations, guestGrants, crossTenantReservations⟩
  | resolve _ _ _ _ _ => exact ⟨delegations, guestGrants, crossTenantReservations⟩
  | delegate fresh =>
      rename_i id secret
      refine ⟨fun candidate candidateSecret raw leak => ?_, guestGrants, crossTenantReservations⟩
      have leak' : tableSet before.delegations id (.ref secret) candidate =
          some (.value candidateSecret raw) := leak
      by_cases same : candidate = id
      · subst same
        rw [tableSet_self] at leak'
        exact SecretCarrier.noConfusion (Option.some.inj leak')
      · rw [tableSet_other _ _ _ same] at leak'
        exact delegations candidate candidateSecret raw leak'
  | guestGrant fresh =>
      rename_i id secret
      refine ⟨delegations, fun candidate candidateSecret raw leak => ?_, crossTenantReservations⟩
      have leak' : tableSet before.guestGrants id (.ref secret) candidate =
          some (.value candidateSecret raw) := leak
      by_cases same : candidate = id
      · subst same
        rw [tableSet_self] at leak'
        exact SecretCarrier.noConfusion (Option.some.inj leak')
      · rw [tableSet_other _ _ _ same] at leak'
        exact guestGrants candidate candidateSecret raw leak'
  | crossTenantReserve fresh =>
      rename_i id secret
      refine ⟨delegations, guestGrants, fun candidate candidateSecret raw leak => ?_⟩
      have leak' : tableSet before.crossTenantReservations id (.ref secret) candidate =
          some (.value candidateSecret raw) := leak
      by_cases same : candidate = id
      · subst same
        rw [tableSet_self] at leak'
        exact SecretCarrier.noConfusion (Option.some.inj leak')
      · rw [tableSet_other _ _ _ same] at leak'
        exact crossTenantReservations candidate candidateSecret raw leak'

inductive SecretReachable : SecretLedger → Prop
  | boot : SecretReachable .boot
  | step {before label after} : SecretReachable before → SecretStep before label after →
      SecretReachable after

/-- **Every reachable ledger's carriers are refs only.** A delegation, guest Membership,
    or cross-tenant reservation reachable in this model never holds a raw
    `SecretValue` — only `SecretCarrier.ref`. -/
theorem reachable_carriers_ref_only {ledger} (reachable : SecretReachable ledger) :
    CarrierRefOnly ledger := by
  induction reachable with
  | boot => exact boot_carriers_ref_only
  | step _ step ih => exact secret_step_preserves_carrier_ref_only ih step

/-- **A raw value in a carrier refutes reachability.** The constructive form of §3.5's
    custody rule for carried records: a ledger whose delegation, guest-grant, or
    cross-tenant-reservation carrier holds the raw `SecretValue` is not reachable — the
    model refuses to produce such a ledger at all. -/
theorem secret_value_carrier_is_unreachable {ledger id secret raw}
    (leak : ledger.delegations id = some (.value secret raw)) : ¬ SecretReachable ledger :=
  fun reachable => (reachable_carriers_ref_only reachable).1 id secret raw leak

theorem guest_grant_value_carrier_is_unreachable {ledger id secret raw}
    (leak : ledger.guestGrants id = some (.value secret raw)) : ¬ SecretReachable ledger :=
  fun reachable => (reachable_carriers_ref_only reachable).2.1 id secret raw leak

theorem cross_tenant_reservation_value_carrier_is_unreachable {ledger id secret raw}
    (leak : ledger.crossTenantReservations id = some (.value secret raw)) :
    ¬ SecretReachable ledger :=
  fun reachable => (reachable_carriers_ref_only reachable).2.2 id secret raw leak

end AgentCore
