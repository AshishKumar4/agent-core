import AgentCore.Slots
import AgentCore.Policy

/-!
# Commands (SPEC §4.3)

A Command is a contribution, not a primitive: installing one changes no code anywhere.
Three promises are normative, plus the submission idempotency the source Operation
(`host.command.submit`, §6.1/§8.5) enforces:

1. **Collision rejects.** A command name is unique per surface slot per Scope; whichever
   of two colliding contributions installs first, the later one rejects.
2. **The derived Subscription is exactly the fixed defaults.** Initiator authority
   through the command's own Binding, `event` dedupe, the declared target Operation,
   and an explicit nonempty accepted-trust set. Nothing can install a command whose
   stored route deviates from the derivation.
3. **Mapping and schemas are checked at install; the produced value validates at
   execution.** Install admits only mappings that send every schema-valid argument
   value to a value the target Operation's input schema accepts, so every emitted
   `command.invoked` input validates — the execution-time half is a consequence of the
   install-time guard, proved across the step relation.

Submission: one `(caller, idempotencyKey)` identity reserves one recorded outcome.
Resubmitting the same envelope returns that recorded reply as a `duplicate` write citing
the original — evidence, never a second effect: it mints no `command.invoked` Event and
reserves nothing new.

Schemas and mappings are abstracted as environments supplied to the step relation; the
concrete JSON-Schema compatibility algorithm, argument grammar, alias configuration, and
`command.completed` result rendering are outside this model.
-/

namespace AgentCore

structure MappingId where value : Nat deriving DecidableEq, Repr
structure CommandName where value : Nat deriving DecidableEq, Repr

/-- The canonical command identity `${facetId}:${name}` (§4.3). -/
structure CommandId where
  facet : FacetId
  name : CommandName
  deriving DecidableEq, Repr

structure CommandDecl where
  name : CommandName
  surfaces : List SlotName
  argumentsSchema : SchemaId
  operation : OperationId
  inputSchema : SchemaId
  binding : BindingId
  mapping : MappingId
  acceptedTrust : Option (List TrustTier)
  deriving DecidableEq, Repr

def CommandDecl.id (command : CommandDecl) : CommandId :=
  ⟨command.operation.facet, command.name⟩

inductive RouteDedupe where | none | event | causation | payload deriving DecidableEq, Repr

inductive CommandAuthority where
  | initiator (binding : BindingId)
  | delegated (binding : BindingId)
  deriving DecidableEq, Repr

/-- The derived Subscription of an installed command, reduced to its declared data:
    source command, accepted trust, target, dedupe policy, and authority source. The
    fixed root-of-`/input` payload projection is common to every derivation. -/
structure CommandRoute where
  source : CommandId
  acceptedTrust : List TrustTier
  target : OperationId
  dedupe : RouteDedupe
  authority : CommandAuthority
  deriving DecidableEq, Repr

def defaultCommandTrust : List TrustTier := [.owner, .authenticated, .self]

def deriveCommandRoute (command : CommandDecl) : CommandRoute :=
  { source := command.id
    acceptedTrust := command.acceptedTrust.getD defaultCommandTrust
    target := command.operation
    dedupe := .event
    authority := .initiator command.binding }

structure InstalledCommand where
  command : CommandDecl
  route : CommandRoute
  deriving DecidableEq, Repr

/-- One emitted `command.invoked` occurrence: the Scope, the command, and the validated
    Operation input carried at `/input`. -/
structure CommandInvocation where
  scope : Scope
  command : CommandId
  input : StructuralValue
  deriving DecidableEq, Repr

structure CommandRegistry where
  commands : Scope → CommandId → Option InstalledCommand
  surfaces : Scope → SlotName → CommandName → Option CommandId
  invoked : List CommandInvocation

instance : Inhabited CommandRegistry where
  default := ⟨fun _ _ => none, fun _ _ _ => none, []⟩

/-- §4.3 step 3, install-time half: the mapping sends every argument value its schema
    accepts to a value the target Operation's input schema accepts. -/
def MappingSchemaSafe (schemas : SchemaId → StructuralValue → Bool)
    (mappings : MappingId → StructuralValue → StructuralValue)
    (command : CommandDecl) : Prop :=
  ∀ value, schemas command.argumentsSchema value = true →
    schemas command.inputSchema (mappings command.mapping value) = true

def CommandRegistry.installCommand (registry : CommandRegistry) (scope : Scope)
    (command : CommandDecl) : CommandRegistry := {
  registry with
  commands := fun candidateScope candidateId =>
    if candidateScope = scope ∧ candidateId = command.id then
      some ⟨command, deriveCommandRoute command⟩
    else registry.commands candidateScope candidateId
  surfaces := fun candidateScope slot candidateName =>
    if candidateScope = scope ∧ candidateName = command.name ∧ slot ∈ command.surfaces then
      some command.id
    else registry.surfaces candidateScope slot candidateName
}

def CommandRegistry.InstalledMappingsSafe (schemas : SchemaId → StructuralValue → Bool)
    (mappings : MappingId → StructuralValue → StructuralValue)
    (registry : CommandRegistry) : Prop :=
  ∀ scope id installed, registry.commands scope id = some installed →
    MappingSchemaSafe schemas mappings installed.command

inductive CommandLabel where
  | installCommand (scope : Scope) (command : CommandDecl)
  | reinstallCommand (scope : Scope) (id : CommandId)
  | invoke (scope : Scope) (id : CommandId) (arguments : StructuralValue)
  deriving DecidableEq, Repr

/-- Command transitions.

* `installCommand` — the guarded materialization: a well-formed declaration (nonempty
  surfaces, nonempty declared trust), an install-checked mapping, a fresh canonical id,
  and a fresh `(surface, name)` position in every declared surface slot. The stored
  record carries exactly the derived route.
* `reinstallCommand` — the stored no-op for an already-installed command.
* `invoke` — argument binding: the Surface validates the argument value against the
  command's schema before any Event is emitted, then the declared pure mapping produces
  the Operation input carried by `command.invoked`. -/
inductive CommandStep (schemas : SchemaId → StructuralValue → Bool)
    (mappings : MappingId → StructuralValue → StructuralValue) :
    CommandRegistry → CommandLabel → CommandRegistry → Prop
  | installCommand {registry : CommandRegistry} {scope : Scope} {command : CommandDecl} :
      command.surfaces ≠ [] →
      (∀ tiers, command.acceptedTrust = some tiers → tiers ≠ []) →
      MappingSchemaSafe schemas mappings command →
      registry.commands scope command.id = none →
      (∀ surface ∈ command.surfaces, registry.surfaces scope surface command.name = none) →
      CommandStep schemas mappings registry (.installCommand scope command)
        (registry.installCommand scope command)
  | reinstallCommand {registry : CommandRegistry} {scope : Scope} {id : CommandId}
      {installed : InstalledCommand} :
      registry.commands scope id = some installed →
      CommandStep schemas mappings registry (.reinstallCommand scope id) registry
  | invoke {registry : CommandRegistry} {scope : Scope} {id : CommandId}
      {installed : InstalledCommand} {arguments : StructuralValue} :
      registry.commands scope id = some installed →
      schemas installed.command.argumentsSchema arguments = true →
      CommandStep schemas mappings registry (.invoke scope id arguments)
        { registry with invoked :=
            ⟨scope, id, mappings installed.command.mapping arguments⟩ :: registry.invoked }

/-- **A name collision rejects the later contribution.** A stored occupant of any
    declared `(surface, name)` position in the Scope rejects the installation — in
    whichever order the two colliding contributions arrive. -/
theorem command_surface_collision_rejected {schemas mappings}
    {registry after : CommandRegistry} {scope : Scope} {command : CommandDecl}
    {surface : SlotName} {occupant : CommandId}
    (declared : surface ∈ command.surfaces)
    (occupied : registry.surfaces scope surface command.name = some occupant) :
    ¬ CommandStep schemas mappings registry (.installCommand scope command) after := by
  intro step
  cases step with
  | installCommand _ _ _ _ freshSurfaces =>
      rw [freshSurfaces surface declared] at occupied
      contradiction

/-- **An occupied canonical id never re-installs.** The identical no-op is
    `reinstallCommand`; installation targets fresh ids only. -/
theorem occupied_command_id_installation_rejected {schemas mappings}
    {registry after : CommandRegistry} {scope : Scope} {command : CommandDecl}
    {installed : InstalledCommand}
    (stored : registry.commands scope command.id = some installed) :
    ¬ CommandStep schemas mappings registry (.installCommand scope command) after := by
  intro step
  cases step with
  | installCommand _ _ _ freshId _ => rw [stored] at freshId; contradiction

/-- **Reinstallation is a stored identity.** The no-op path exists only for an
    installed command and changes nothing. -/
theorem command_reinstallation_is_stored_identity {schemas mappings}
    {registry after : CommandRegistry} {scope : Scope} {id : CommandId}
    (step : CommandStep schemas mappings registry (.reinstallCommand scope id) after) :
    after = registry ∧ ∃ installed, registry.commands scope id = some installed := by
  cases step with
  | reinstallCommand stored => exact ⟨rfl, _, stored⟩

/-- **Installation stores exactly the derived route and registers every declared
    surface.** The stored record is the declaration plus its canonical derivation —
    no inferred compatibility relation or alternate authority source. -/
theorem installation_registers_exact_derived_route {schemas mappings}
    {registry after : CommandRegistry} {scope : Scope} {command : CommandDecl}
    (step : CommandStep schemas mappings registry (.installCommand scope command) after) :
    after.commands scope command.id = some ⟨command, deriveCommandRoute command⟩ ∧
      ∀ surface ∈ command.surfaces,
        after.surfaces scope surface command.name = some command.id := by
  cases step with
  | installCommand _ _ _ _ _ =>
      constructor
      · simp [CommandRegistry.installCommand]
      · intro surface declared
        simp [CommandRegistry.installCommand, declared]

/-- **A route deviating from the derivation cannot be installed.** If the stored route
    differs from `deriveCommandRoute` in any field, no installation step produced it. -/
theorem nonderived_route_installation_rejected {schemas mappings}
    {registry after : CommandRegistry} {scope : Scope} {command : CommandDecl}
    {installed : InstalledCommand}
    (stored : after.commands scope command.id = some installed)
    (askew : installed.route ≠ deriveCommandRoute installed.command) :
    ¬ CommandStep schemas mappings registry (.installCommand scope command) after := by
  intro step
  obtain ⟨exact, _⟩ := installation_registers_exact_derived_route step
  rw [stored] at exact
  cases Option.some.inj exact
  exact askew rfl

/-- **The derived route is initiator authority, `event` dedupe, the declared target,
    and a nonempty accepted-trust set.** §4.3's fixed defaults, with the nonemptiness
    guaranteed by the install guard even when the trust set is declared explicitly. -/
theorem installed_route_is_initiator_with_event_dedupe {schemas mappings}
    {registry after : CommandRegistry} {scope : Scope} {command : CommandDecl}
    (step : CommandStep schemas mappings registry (.installCommand scope command) after) :
    ∃ installed, after.commands scope command.id = some installed ∧
      installed.route.authority = .initiator command.binding ∧
      installed.route.dedupe = .event ∧
      installed.route.target = command.operation ∧
      installed.route.acceptedTrust ≠ [] := by
  cases step with
  | installCommand _ trustGuard _ _ _ =>
      refine ⟨⟨command, deriveCommandRoute command⟩,
        by simp [CommandRegistry.installCommand], rfl, rfl, rfl, ?_⟩
      cases explicit : command.acceptedTrust with
      | none => simp [deriveCommandRoute, explicit, defaultCommandTrust]
      | some tiers => simpa [deriveCommandRoute, explicit] using trustGuard tiers explicit

/-- **An empty declared trust set rejects at install.** The derived Subscription's
    accepted trust is always explicit and nonempty (§4.3); a contribution declaring an
    empty set never installs. -/
theorem empty_trust_installation_rejected {schemas mappings}
    {registry after : CommandRegistry} {scope : Scope} {command : CommandDecl}
    (declaredEmpty : command.acceptedTrust = some []) :
    ¬ CommandStep schemas mappings registry (.installCommand scope command) after := by
  intro step
  cases step with
  | installCommand _ trustGuard _ _ _ => exact trustGuard [] declaredEmpty rfl

/-- **An install-unsafe mapping rejects at install.** A mapping that could send a
    schema-valid argument value to a value the Operation input schema rejects never
    installs (§4.3 step 3). -/
theorem unsafe_mapping_installation_rejected {schemas mappings}
    {registry after : CommandRegistry} {scope : Scope} {command : CommandDecl}
    (unsafeMapping : ¬ MappingSchemaSafe schemas mappings command) :
    ¬ CommandStep schemas mappings registry (.installCommand scope command) after := by
  intro step
  cases step with
  | installCommand _ _ safe _ _ => exact unsafeMapping safe

/-- **Only an installed command invokes.** -/
theorem uninstalled_command_invocation_rejected {schemas mappings}
    {registry after : CommandRegistry} {scope : Scope} {id : CommandId}
    {arguments : StructuralValue}
    (missing : registry.commands scope id = none) :
    ¬ CommandStep schemas mappings registry (.invoke scope id arguments) after := by
  intro step
  cases step with
  | invoke stored _ => rw [missing] at stored; contradiction

/-- **Arguments validate before any Event is emitted.** An argument value the command's
    schema rejects cannot invoke (§4.3 step 3). -/
theorem invalid_arguments_invocation_rejected {schemas mappings}
    {registry after : CommandRegistry} {scope : Scope} {id : CommandId}
    {installed : InstalledCommand} {arguments : StructuralValue}
    (stored : registry.commands scope id = some installed)
    (invalid : schemas installed.command.argumentsSchema arguments = false) :
    ¬ CommandStep schemas mappings registry (.invoke scope id arguments) after := by
  intro step
  cases step with
  | invoke lookup accepted =>
      rw [stored] at lookup
      cases Option.some.inj lookup
      rw [invalid] at accepted
      contradiction

/-- **Installed mappings stay install-checked.** Every stored command keeps the
    install-time mapping guarantee across every transition. -/
theorem command_step_preserves_installed_mapping_safety {schemas mappings}
    {before after : CommandRegistry} {label}
    (safe : before.InstalledMappingsSafe schemas mappings)
    (step : CommandStep schemas mappings before label after) :
    after.InstalledMappingsSafe schemas mappings := by
  cases step with
  | installCommand _ _ commandSafe _ _ =>
      intro scope id installed lookup
      simp only [CommandRegistry.installCommand] at lookup
      split at lookup
      · cases Option.some.inj lookup
        exact commandSafe
      · exact safe scope id installed lookup
  | reinstallCommand _ => exact safe
  | invoke _ _ => exact safe

/-- **Surface registrations are stable.** No transition clears an occupied
    `(Scope, surface, name)` position, so a colliding contribution stays rejected. -/
theorem command_step_preserves_surface_registration {schemas mappings}
    {before after : CommandRegistry} {label} {scope : Scope} {surface : SlotName}
    {name : CommandName} {id : CommandId}
    (step : CommandStep schemas mappings before label after)
    (stored : before.surfaces scope surface name = some id) :
    after.surfaces scope surface name = some id := by
  cases step with
  | installCommand _ _ _ _ freshSurfaces =>
      rename_i incomingScope incoming
      simp only [CommandRegistry.installCommand]
      split
      · rename_i condition
        rw [condition.1, condition.2.1] at stored
        rw [freshSurfaces surface condition.2.2] at stored
        contradiction
      · exact stored
  | reinstallCommand _ => exact stored
  | invoke _ _ => exact stored

/-- **Every emitted `command.invoked` input validates against the target Operation's
    input schema.** The execution-time half of §4.3 step 3, derived across the step
    relation from the install-time guard: the Surface validated the arguments, the
    declared pure mapping produced the input, and the installed mapping is
    install-checked. -/
theorem invocation_emits_validated_operation_input {schemas mappings}
    {before after : CommandRegistry} {scope : Scope} {id : CommandId}
    {arguments : StructuralValue}
    (safe : before.InstalledMappingsSafe schemas mappings)
    (step : CommandStep schemas mappings before (.invoke scope id arguments) after) :
    ∃ installed invocation,
      before.commands scope id = some installed ∧
      after.invoked = invocation :: before.invoked ∧
      invocation.scope = scope ∧ invocation.command = id ∧
      invocation.input = mappings installed.command.mapping arguments ∧
      schemas installed.command.argumentsSchema arguments = true ∧
      schemas installed.command.inputSchema invocation.input = true := by
  cases step with
  | invoke stored accepted =>
      exact ⟨_, _, stored, rfl, rfl, rfl, rfl, accepted,
        safe scope id _ stored arguments accepted⟩

/-! ## Command submission idempotency (§4.3 invocation via §6.1 `host.command.submit`)

The submission ledger records one write per request. A committed submission reserves
its `(caller, idempotencyKey)` identity and mints exactly one `command.invoked` Event;
an identified rejection reserves its identity without minting; a resubmission of a
reserved identity appends a `duplicate` write citing the reserving original and
returning its recorded reply — no new reservation, no new Event. -/

inductive SubmissionCaller where
  | principal (ref : PrincipalRef)
  | actor (ref : ActorRef)
  deriving DecidableEq, Repr

structure SubmissionKey where value : Nat deriving DecidableEq, Repr

/-- The §8.5 duplicate-lookup identity: exact caller plus idempotency key. -/
structure SubmissionIdentity where
  caller : SubmissionCaller
  key : SubmissionKey
  deriving DecidableEq, Repr

structure SubmissionWriteId where value : Nat deriving DecidableEq, Repr

inductive SubmissionOutcome where
  | committed
  | rejected
  | duplicate (original : SubmissionWriteId)
  deriving DecidableEq, Repr

/-- A duplicate write is evidence of the recorded outcome; it reserves nothing. -/
def SubmissionOutcome.Reserves : SubmissionOutcome → Prop
  | .duplicate _ => False
  | _ => True

structure SubmissionWrite where
  identity : SubmissionIdentity
  outcome : SubmissionOutcome
  reply : StructuralValue
  deriving DecidableEq, Repr

structure SubmissionLedger where
  writes : SubmissionWriteId → Option SubmissionWrite
  reserved : SubmissionIdentity → Option SubmissionWriteId
  invoked : List EventId

instance : Inhabited SubmissionLedger where
  default := ⟨fun _ => none, fun _ => none, []⟩

/-- The reservation index and the write log agree: a reservation points at a reserving
    write of its identity, and every reserving write is indexed under its identity. -/
def SubmissionLedger.ReservationConsistent (ledger : SubmissionLedger) : Prop :=
  (∀ identity id, ledger.reserved identity = some id →
    ∃ write, ledger.writes id = some write ∧ write.identity = identity ∧
      write.outcome.Reserves) ∧
  (∀ id write, ledger.writes id = some write → write.outcome.Reserves →
    ledger.reserved write.identity = some id)

inductive SubmissionLabel where
  | commit (id : SubmissionWriteId) (event : EventId)
  | reject (id : SubmissionWriteId)
  | resubmit (id : SubmissionWriteId)
  deriving DecidableEq, Repr

/-- Submission transitions.

* `commit` — an unreserved identity commits: the write reserves the identity and mints
  exactly one `command.invoked` Event.
* `reject` — an identified rejection reserves the identity with its recorded outcome
  and mints nothing (a denied or failed source action emits no source Event, §6.1).
* `resubmit` — a reserved identity resubmits: the appended write is a `duplicate`
  citing the reserving original and carrying its recorded reply; the reservation index
  and the emitted Events are untouched. -/
inductive SubmissionStep : SubmissionLedger → SubmissionLabel → SubmissionLedger → Prop
  | commit {ledger : SubmissionLedger} {id : SubmissionWriteId} {write : SubmissionWrite}
      {event : EventId} :
      ledger.writes id = none →
      ledger.reserved write.identity = none →
      write.outcome = .committed →
      SubmissionStep ledger (.commit id event) {
        writes := tableSet ledger.writes id write
        reserved := tableSet ledger.reserved write.identity id
        invoked := event :: ledger.invoked }
  | reject {ledger : SubmissionLedger} {id : SubmissionWriteId} {write : SubmissionWrite} :
      ledger.writes id = none →
      ledger.reserved write.identity = none →
      write.outcome = .rejected →
      SubmissionStep ledger (.reject id) {
        writes := tableSet ledger.writes id write
        reserved := tableSet ledger.reserved write.identity id
        invoked := ledger.invoked }
  | resubmit {ledger : SubmissionLedger} {id originalId : SubmissionWriteId}
      {write original : SubmissionWrite} :
      ledger.writes id = none →
      ledger.reserved write.identity = some originalId →
      ledger.writes originalId = some original →
      original.identity = write.identity →
      write.outcome = .duplicate originalId →
      write.reply = original.reply →
      SubmissionStep ledger (.resubmit id) { ledger with writes := tableSet ledger.writes id write }

/-- **A commitment requires an unreserved identity and mints one Event.** -/
theorem commit_requires_unreserved_identity {ledger after : SubmissionLedger}
    {id : SubmissionWriteId} {event : EventId}
    (step : SubmissionStep ledger (.commit id event) after) :
    ∃ write, after.writes id = some write ∧
      ledger.reserved write.identity = none ∧ write.outcome = .committed ∧
      after.reserved write.identity = some id ∧
      after.invoked = event :: ledger.invoked := by
  cases step with
  | commit fresh unreserved committed =>
      exact ⟨_, tableSet_self .., unreserved, committed, tableSet_self .., rfl⟩

/-- **A reserved identity never commits again.** Once any write reserves the identity,
    a second committing submission for it is impossible — the recorded outcome is the
    only outcome that identity will ever have. -/
theorem reserved_identity_cannot_recommit {ledger after : SubmissionLedger}
    {id originalId : SubmissionWriteId} {event : EventId} {write : SubmissionWrite}
    (stored : after.writes id = some write)
    (reservedAlready : ledger.reserved write.identity = some originalId) :
    ¬ SubmissionStep ledger (.commit id event) after := by
  intro step
  obtain ⟨committed, storedCommit, unreserved, _, _, _⟩ := commit_requires_unreserved_identity step
  rw [stored] at storedCommit
  cases Option.some.inj storedCommit
  rw [reservedAlready] at unreserved
  contradiction

/-- **Resubmission returns the recorded reply.** The appended write is a `duplicate`
    citing the write that reserved the identity, and its reply is the original's. -/
theorem resubmission_returns_recorded_reply {ledger after : SubmissionLedger}
    {id : SubmissionWriteId}
    (step : SubmissionStep ledger (.resubmit id) after) :
    ∃ write originalId original,
      after.writes id = some write ∧
      ledger.reserved write.identity = some originalId ∧
      ledger.writes originalId = some original ∧
      original.identity = write.identity ∧
      write.outcome = .duplicate originalId ∧
      write.reply = original.reply := by
  cases step with
  | resubmit fresh reservedLookup originalLookup sameIdentity duplicate reply =>
      exact ⟨_, _, _, tableSet_self .., reservedLookup, originalLookup, sameIdentity,
        duplicate, reply⟩

/-- **A duplicate reserves nothing and emits nothing.** Resubmission leaves the
    reservation index and the emitted `command.invoked` Events untouched: evidence,
    not a second effect. -/
theorem duplicate_submission_reserves_and_emits_nothing {ledger after : SubmissionLedger}
    {id : SubmissionWriteId}
    (step : SubmissionStep ledger (.resubmit id) after) :
    after.reserved = ledger.reserved ∧ after.invoked = ledger.invoked := by
  cases step with
  | resubmit _ _ _ _ _ _ => exact ⟨rfl, rfl⟩

/-- **A duplicate cites a reserving original.** Under reservation consistency the cited
    original is itself a committed or rejected write — a duplicate never chains onto
    another duplicate. -/
theorem duplicate_cites_reserving_original {ledger after : SubmissionLedger}
    {id : SubmissionWriteId}
    (consistent : ledger.ReservationConsistent)
    (step : SubmissionStep ledger (.resubmit id) after) :
    ∃ write originalId original,
      after.writes id = some write ∧ write.outcome = .duplicate originalId ∧
      ledger.writes originalId = some original ∧ original.outcome.Reserves ∧
      write.reply = original.reply := by
  obtain ⟨write, originalId, original, stored, reservedLookup, originalLookup, _, duplicate,
    reply⟩ := resubmission_returns_recorded_reply step
  obtain ⟨reserving, reservingLookup, _, reserves⟩ := consistent.1 _ _ reservedLookup
  rw [originalLookup] at reservingLookup
  cases Option.some.inj reservingLookup
  exact ⟨write, originalId, original, stored, duplicate, originalLookup, reserves, reply⟩

/-- **Reservation consistency is preserved.** Along every trace, the reservation index
    and the reserving writes agree — resubmission can never manufacture a second
    reserving write for an identity. -/
theorem submission_step_preserves_reservation_consistency
    {before after : SubmissionLedger} {label}
    (consistent : before.ReservationConsistent)
    (step : SubmissionStep before label after) :
    after.ReservationConsistent := by
  cases step with
  | commit fresh unreserved committed =>
      rename_i id write event
      constructor
      · intro identity reservedId lookup
        have reservedTable : tableSet before.reserved write.identity id identity =
            some reservedId := lookup
        by_cases same : identity = write.identity
        · subst same
          rw [tableSet_self] at reservedTable
          cases Option.some.inj reservedTable
          exact ⟨write, tableSet_self .., rfl, by rw [committed]; trivial⟩
        · rw [tableSet_other before.reserved write.identity identity same] at reservedTable
          obtain ⟨stored, storedLookup, storedIdentity, reserves⟩ :=
            consistent.1 identity reservedId reservedTable
          refine ⟨stored, ?_, storedIdentity, reserves⟩
          show tableSet before.writes id write reservedId = some stored
          by_cases sameId : reservedId = id
          · subst sameId
            rw [fresh] at storedLookup
            contradiction
          · rw [tableSet_other before.writes id reservedId sameId]
            exact storedLookup
      · intro candidateId candidate lookup reserves
        have writeTable : tableSet before.writes id write candidateId = some candidate := lookup
        show tableSet before.reserved write.identity id candidate.identity = some candidateId
        by_cases sameId : candidateId = id
        · subst sameId
          rw [tableSet_self] at writeTable
          cases Option.some.inj writeTable
          exact tableSet_self ..
        · rw [tableSet_other before.writes id candidateId sameId] at writeTable
          have indexed := consistent.2 candidateId candidate writeTable reserves
          by_cases same : candidate.identity = write.identity
          · rw [same] at indexed
            rw [unreserved] at indexed
            contradiction
          · rw [tableSet_other before.reserved write.identity candidate.identity same]
            exact indexed
  | reject fresh unreserved rejected =>
      rename_i id write
      constructor
      · intro identity reservedId lookup
        have reservedTable : tableSet before.reserved write.identity id identity =
            some reservedId := lookup
        by_cases same : identity = write.identity
        · subst same
          rw [tableSet_self] at reservedTable
          cases Option.some.inj reservedTable
          exact ⟨write, tableSet_self .., rfl, by rw [rejected]; trivial⟩
        · rw [tableSet_other before.reserved write.identity identity same] at reservedTable
          obtain ⟨stored, storedLookup, storedIdentity, reserves⟩ :=
            consistent.1 identity reservedId reservedTable
          refine ⟨stored, ?_, storedIdentity, reserves⟩
          show tableSet before.writes id write reservedId = some stored
          by_cases sameId : reservedId = id
          · subst sameId
            rw [fresh] at storedLookup
            contradiction
          · rw [tableSet_other before.writes id reservedId sameId]
            exact storedLookup
      · intro candidateId candidate lookup reserves
        have writeTable : tableSet before.writes id write candidateId = some candidate := lookup
        show tableSet before.reserved write.identity id candidate.identity = some candidateId
        by_cases sameId : candidateId = id
        · subst sameId
          rw [tableSet_self] at writeTable
          cases Option.some.inj writeTable
          exact tableSet_self ..
        · rw [tableSet_other before.writes id candidateId sameId] at writeTable
          have indexed := consistent.2 candidateId candidate writeTable reserves
          by_cases same : candidate.identity = write.identity
          · rw [same] at indexed
            rw [unreserved] at indexed
            contradiction
          · rw [tableSet_other before.reserved write.identity candidate.identity same]
            exact indexed
  | resubmit fresh reservedLookup originalLookup sameIdentity duplicate reply =>
      rename_i id originalId write original
      constructor
      · intro identity reservedId lookup
        obtain ⟨stored, storedLookup, storedIdentity, reserves⟩ :=
          consistent.1 identity reservedId lookup
        refine ⟨stored, ?_, storedIdentity, reserves⟩
        show tableSet before.writes id write reservedId = some stored
        by_cases sameId : reservedId = id
        · subst sameId
          rw [fresh] at storedLookup
          contradiction
        · rw [tableSet_other before.writes id reservedId sameId]
          exact storedLookup
      · intro candidateId candidate lookup reserves
        have writeTable : tableSet before.writes id write candidateId = some candidate := lookup
        by_cases sameId : candidateId = id
        · subst sameId
          rw [tableSet_self] at writeTable
          cases Option.some.inj writeTable
          rw [duplicate] at reserves
          exact absurd reserves not_false
        · rw [tableSet_other before.writes id candidateId sameId] at writeTable
          exact consistent.2 candidateId candidate writeTable reserves

/-- **At most one reserving write per identity.** In any consistent ledger, two
    reserving writes with the same identity are the same write. -/
theorem at_most_one_reserving_write_per_identity {ledger : SubmissionLedger}
    {leftId rightId : SubmissionWriteId} {left right : SubmissionWrite}
    (consistent : ledger.ReservationConsistent)
    (leftLookup : ledger.writes leftId = some left)
    (rightLookup : ledger.writes rightId = some right)
    (sameIdentity : left.identity = right.identity)
    (leftReserves : left.outcome.Reserves) (rightReserves : right.outcome.Reserves) :
    leftId = rightId := by
  have leftIndexed := consistent.2 leftId left leftLookup leftReserves
  have rightIndexed := consistent.2 rightId right rightLookup rightReserves
  rw [sameIdentity] at leftIndexed
  rw [leftIndexed] at rightIndexed
  exact Option.some.inj rightIndexed

end AgentCore
