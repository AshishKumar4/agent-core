import AgentCore.RunGraph

/-!
# Environment and Session (SPEC §4.5)

An Environment is an execution endpoint that opens live Sessions; a Session exposes
session-scoped child Facets. The labeled transition system here models the §4.5 rules
as guards on one step relation:

* every session-scoped use — a filesystem write, an egress send, a snapshot, a port
  exposure — presents a capability for the exact session epoch and an admitted lease
  token for the Session's owning Turn, so a stale Session admits nothing and "Turn-owned
  Session" is a proved gate, not an asserted flag;
* closing a Session is terminal: it clears the session-visible state, revokes the
  Session's port exposures, and no later transition revives the record;
* rotation advances the Environment head without touching any existing Session, and an
  open pins the head revision and generation active at open time;
* egress is explicitly bound: a send names an `EgressGrant` and reaches exactly the
  destination that grant records — there is no unbound send constructor, which is
  §1.5's zero ambient egress at this seam;
* the credential-isolation seam: the proxy attaches a credential at the egress
  boundary — the send appends an egress record naming it — and never inside the
  Session. Session-visible values are built from `AgentValue`, which §3.5's custody
  rule keeps plaintext-free; `StoredValue.plaintext` makes the violation representable,
  and the invariant proves the whole session-visible plane — files and the snapshots
  that restore into files — never holds it at any reachable state.

The concrete provider — container execution, reconciliation RPC, snapshot byte
formats, preview-host token derivation — stays behind `NC-ENVIRONMENT-LIFECYCLE`.
-/

namespace AgentCore

structure SecretId where value : Nat deriving DecidableEq, Repr
structure SessionId where value : Nat deriving DecidableEq, Repr
structure SnapshotId where value : Nat deriving DecidableEq, Repr
structure ExposureId where value : Nat deriving DecidableEq, Repr
structure Destination where value : Nat deriving DecidableEq, Repr

/-- What a session-visible cell can hold. `plaintext` is representable so that the
credential-isolation invariant excludes something real: a model in which the violation
cannot even be written down proves nothing. -/
inductive StoredValue where
  | data (payload : Nat)
  | ref (secret : SecretId)
  | plaintext (secret : SecretId)
  deriving DecidableEq, Repr

/-- The value vocabulary of the agent-visible domain. It carries data and SecretRefs but
no resolved plaintext: §3.5 denies a resolution attempted outside custody, so nothing the
session domain presents for writing can be the raw credential. -/
inductive AgentValue where
  | data (payload : Nat)
  | ref (secret : SecretId)
  deriving DecidableEq, Repr

def AgentValue.stored : AgentValue → StoredValue
  | .data payload => .data payload
  | .ref secret => .ref secret

theorem AgentValue.stored_is_not_plaintext (value : AgentValue) (secret : SecretId) :
    value.stored ≠ .plaintext secret := by cases value <;> simp [AgentValue.stored]

inductive SessionPhase where | live | lost | closed deriving DecidableEq, Repr

structure EnvironmentRecord where
  revision : Nat
  generation : Nat
  deriving DecidableEq, Repr

structure SessionRecord where
  environment : EnvironmentId
  revision : Nat
  generation : Nat
  owner : TurnId
  epoch : Nat
  phase : SessionPhase
  deriving DecidableEq, Repr

structure SnapshotRecord where
  session : SessionId
  content : String → Option StoredValue

structure ExposureRecord where
  session : SessionId
  sessionEpoch : Nat
  port : Nat
  live : Bool
  deriving DecidableEq, Repr

structure EgressGrant where
  destination : Destination
  credential : Option SecretId
  deriving DecidableEq, Repr

structure EgressRecord where
  session : SessionId
  binding : BindingId
  destination : Destination
  credential : Option SecretId
  deriving DecidableEq, Repr

structure IngressRecord where
  exposure : ExposureId
  session : SessionId
  port : Nat
  deriving DecidableEq, Repr

/-- The capability a session-scoped child Facet call presents: the exact session, the
exact epoch it was minted for, and a lease token for the owning Turn. -/
structure SessionUse where
  session : SessionId
  epoch : Nat
  token : LeaseToken
  now : Time
  deriving DecidableEq, Repr

structure EnvironmentLedger where
  environments : EnvironmentId → Option EnvironmentRecord
  sessions : SessionId → Option SessionRecord
  files : SessionId → String → Option StoredValue
  snapshots : SnapshotId → Option SnapshotRecord
  exposures : ExposureId → Option ExposureRecord
  egressGrants : BindingId → Option EgressGrant
  egress : List EgressRecord
  ingress : List IngressRecord
  leases : TurnId → Option TurnLease

def EnvironmentLedger.boot : EnvironmentLedger := {
  environments := fun _ => none
  sessions := fun _ => none
  files := fun _ _ => none
  snapshots := fun _ => none
  exposures := fun _ => none
  egressGrants := fun _ => none
  egress := []
  ingress := []
  leases := fun _ => none
}

instance : Inhabited EnvironmentLedger where default := .boot

def setFiles (files : SessionId → String → Option StoredValue) (session : SessionId)
    (content : String → Option StoredValue) : SessionId → String → Option StoredValue :=
  fun candidate => if candidate = session then content else files candidate

@[simp] theorem setFiles_self (files : SessionId → String → Option StoredValue)
    (session : SessionId) (content : String → Option StoredValue) :
    setFiles files session content session = content := by simp [setFiles]

theorem setFiles_other (files : SessionId → String → Option StoredValue)
    (session other : SessionId) (different : other ≠ session)
    (content : String → Option StoredValue) :
    setFiles files session content other = files other := by
  simp [setFiles, different]

def revokeSessionExposures (exposures : ExposureId → Option ExposureRecord)
    (session : SessionId) : ExposureId → Option ExposureRecord :=
  fun id => match exposures id with
    | some exposure =>
        if exposure.session = session then some { exposure with live := false }
        else some exposure
    | none => none

/-- §4.5's use gate. The session exists, is live, the capability names the exact current
epoch, and the presented token is admitted right now by the current lease of the owning
Turn. This predicate is what makes an Environment Session "Turn-owned". -/
def UseAdmitted (ledger : EnvironmentLedger) (use : SessionUse) : Prop :=
  ∃ session lease,
    ledger.sessions use.session = some session ∧ session.phase = .live ∧
    use.epoch = session.epoch ∧
    ledger.leases session.owner = some lease ∧ use.token.turn = session.owner ∧
    lease.Admits use.token use.now

def restoreContent (ledger : EnvironmentLedger) :
    Option SnapshotId → Option (String → Option StoredValue)
  | none => some (fun _ => none)
  | some id => (ledger.snapshots id).map SnapshotRecord.content

inductive EnvironmentLabel where
  | provision (environment : EnvironmentId)
  | rotate (environment : EnvironmentId)
  | registerTurn (turn : TurnId)
  | leaseAction (turn : TurnId) (label : LeaseLabel)
  | bindEgress (binding : BindingId) (grant : EgressGrant)
  | openSession (session : SessionId) (environment : EnvironmentId) (owner : TurnId)
      (token : LeaseToken) (now : Time) (restoreFrom : Option SnapshotId)
  | write (use : SessionUse) (path : String) (value : AgentValue)
  | send (use : SessionUse) (binding : BindingId)
  | snapshot (use : SessionUse) (id : SnapshotId)
  | expose (use : SessionUse) (id : ExposureId) (port : Nat)
  | revoke (exposure : ExposureId)
  | previewIngress (exposure : ExposureId)
  | markLost (session : SessionId)
  | closeSession (session : SessionId)

/-- The session-scoped child-Facet uses: `write` is `env.fs`, `send` is proxied egress,
`snapshot` is the durability child, `expose` is `env.ports`. -/
def EnvironmentLabel.use? : EnvironmentLabel → Option SessionUse
  | .write use _ _ => some use
  | .send use _ => some use
  | .snapshot use _ => some use
  | .expose use _ _ => some use
  | _ => none

inductive EnvironmentStep : EnvironmentLedger → EnvironmentLabel → EnvironmentLedger → Prop
  | provision {ledger environment} :
      ledger.environments environment = none →
      EnvironmentStep ledger (.provision environment)
        { ledger with environments := tableSet ledger.environments environment ⟨0, 0⟩ }
  | rotate {ledger environment record} :
      ledger.environments environment = some record →
      EnvironmentStep ledger (.rotate environment)
        { ledger with
          environments := tableSet ledger.environments environment
            ⟨record.revision + 1, record.generation + 1⟩ }
  | registerTurn {ledger turn} :
      ledger.leases turn = none →
      EnvironmentStep ledger (.registerTurn turn)
        { ledger with leases := tableSet ledger.leases turn (TurnLease.initial turn) }
  | leaseAction {ledger turn lease label lease'} :
      ledger.leases turn = some lease → LeaseStep lease label lease' →
      EnvironmentStep ledger (.leaseAction turn label)
        { ledger with leases := tableSet ledger.leases turn lease' }
  | bindEgress {ledger binding grant} :
      ledger.egressGrants binding = none →
      EnvironmentStep ledger (.bindEgress binding grant)
        { ledger with egressGrants := tableSet ledger.egressGrants binding grant }
  | openSession {ledger session environment owner token now restoreFrom record lease content} :
      ledger.sessions session = none →
      ledger.environments environment = some record →
      ledger.leases owner = some lease → token.turn = owner → lease.Admits token now →
      restoreContent ledger restoreFrom = some content →
      EnvironmentStep ledger (.openSession session environment owner token now restoreFrom)
        { ledger with
          sessions := tableSet ledger.sessions session
            ⟨environment, record.revision, record.generation, owner, 0, .live⟩
          files := setFiles ledger.files session content }
  | write {ledger use path value} :
      UseAdmitted ledger use →
      EnvironmentStep ledger (.write use path value)
        { ledger with
          files := setFiles ledger.files use.session
            (tableSet (ledger.files use.session) path value.stored) }
  | send {ledger use binding grant} :
      UseAdmitted ledger use →
      ledger.egressGrants binding = some grant →
      EnvironmentStep ledger (.send use binding)
        { ledger with
          egress :=
            ⟨use.session, binding, grant.destination, grant.credential⟩ :: ledger.egress }
  | snapshot {ledger use id} :
      UseAdmitted ledger use →
      ledger.snapshots id = none →
      EnvironmentStep ledger (.snapshot use id)
        { ledger with
          snapshots := tableSet ledger.snapshots id
            ⟨use.session, ledger.files use.session⟩ }
  | expose {ledger use id port} :
      UseAdmitted ledger use →
      ledger.exposures id = none →
      EnvironmentStep ledger (.expose use id port)
        { ledger with
          exposures := tableSet ledger.exposures id
            ⟨use.session, use.epoch, port, true⟩ }
  | revoke {ledger id exposure} :
      ledger.exposures id = some exposure →
      EnvironmentStep ledger (.revoke id)
        { ledger with exposures := tableSet ledger.exposures id { exposure with live := false } }
  | previewIngress {ledger id exposure session} :
      ledger.exposures id = some exposure → exposure.live = true →
      ledger.sessions exposure.session = some session → session.phase = .live →
      session.epoch = exposure.sessionEpoch →
      EnvironmentStep ledger (.previewIngress id)
        { ledger with ingress := ⟨id, exposure.session, exposure.port⟩ :: ledger.ingress }
  | markLost {ledger session record} :
      ledger.sessions session = some record → record.phase = .live →
      EnvironmentStep ledger (.markLost session)
        { ledger with
          sessions := tableSet ledger.sessions session
            { record with phase := .lost, epoch := record.epoch + 1 } }
  | closeSession {ledger session record} :
      ledger.sessions session = some record → record.phase ≠ .closed →
      EnvironmentStep ledger (.closeSession session)
        { ledger with
          sessions := tableSet ledger.sessions session
            { record with phase := .closed, epoch := record.epoch + 1 }
          files := setFiles ledger.files session (fun _ => none)
          exposures := revokeSessionExposures ledger.exposures session }

inductive EnvReachable : EnvironmentLedger → Prop
  | boot : EnvReachable .boot
  | step {before label after} :
      EnvReachable before → EnvironmentStep before label after → EnvReachable after


/-- **Every session-scoped use is Turn-owned and live.** A child-Facet call admitted by
the step relation names a live session at its exact current epoch and presents a token
the owning Turn's current lease admits right now. This is the formal ground for §7.2's
"Turn-owned session execute → direct" floor: the Bool `defaultTier` consumes is true
exactly when this gate passed. -/
theorem session_use_is_turn_owned_and_live {ledger label after use}
    (step : EnvironmentStep ledger label after) (isUse : label.use? = some use) :
    ∃ session lease,
      ledger.sessions use.session = some session ∧ session.phase = .live ∧
      use.epoch = session.epoch ∧
      ledger.leases session.owner = some lease ∧ use.token.turn = session.owner ∧
      lease.Admits use.token use.now := by
  have admitted : UseAdmitted ledger use := by
    cases step with
    | write admitted => exact Option.some.inj isUse ▸ admitted
    | send admitted _ => exact Option.some.inj isUse ▸ admitted
    | snapshot admitted _ => exact Option.some.inj isUse ▸ admitted
    | expose admitted _ => exact Option.some.inj isUse ▸ admitted
    | _ => exact Option.noConfusion isUse
  exact admitted

/-- **A stale Session admits nothing.** A session that is lost or closed, or a capability
minted for a superseded epoch, fails closed: no child-Facet use step is admissible. -/
theorem stale_session_admits_nothing {ledger label after use session}
    (lookup : ledger.sessions use.session = some session)
    (stale : session.phase ≠ .live ∨ use.epoch ≠ session.epoch)
    (isUse : label.use? = some use) : ¬ EnvironmentStep ledger label after := by
  intro step
  obtain ⟨found, lease, foundLookup, live, epoch, _, _, _⟩ :=
    session_use_is_turn_owned_and_live step isUse
  rw [lookup] at foundLookup
  cases Option.some.inj foundLookup
  rcases stale with notLive | notEpoch
  · exact notLive live
  · exact notEpoch epoch

/-- **Closing a Session disposes its child Facets.** The close transition atomically
marks the record closed behind a fresh epoch, clears every session-visible file, and
revokes every port exposure the session held. -/
theorem close_disposes_child_facets {ledger session after}
    (step : EnvironmentStep ledger (.closeSession session) after) :
    (∃ record, after.sessions session = some record ∧ record.phase = .closed) ∧
    (∀ path, after.files session path = none) ∧
    (∀ id exposure, after.exposures id = some exposure → exposure.session = session →
      exposure.live = false) := by
  cases step with
  | closeSession lookup notClosed =>
    refine ⟨⟨_, tableSet_self .., rfl⟩,
      fun path => Eq.trans (congrFun (setFiles_self ..) path) rfl, ?_⟩
    intro id exposure revoked sameSession
    have revoked' : (match ledger.exposures id with
        | some found =>
            if found.session = session then some { found with live := false } else some found
        | none => none) = some exposure := revoked
    split at revoked'
    next found _lookupFound =>
      by_cases inSession : found.session = session
      · rw [if_pos inSession] at revoked'
        cases Option.some.inj revoked'
        rfl
      · rw [if_neg inSession] at revoked'
        cases Option.some.inj revoked'
        exact absurd sameSession inSession
    next => exact Option.noConfusion revoked'

/-- **A closed Session is terminal.** No transition of any kind changes a closed session
record, so a disposed child Facet can never come back to life under its Session. -/
theorem closed_session_is_terminal {ledger label after session record}
    (step : EnvironmentStep ledger label after)
    (lookup : ledger.sessions session = some record) (closed : record.phase = .closed) :
    after.sessions session = some record := by
  cases step with
  | openSession fresh _head _leaseLookup _turnEq _admits _restore =>
    rename_i opened _environment _owner _token _now _restoreFrom _record _lease _content
    by_cases same : session = opened
    · subst same
      rw [lookup] at fresh
      exact Option.noConfusion fresh
    · exact Eq.trans (tableSet_other _ _ _ same _) lookup
  | markLost found live =>
    rename_i lost _lostRecord
    by_cases same : session = lost
    · subst same
      rw [lookup] at found
      cases Option.some.inj found
      rw [closed] at live
      exact SessionPhase.noConfusion live
    · exact Eq.trans (tableSet_other _ _ _ same _) lookup
  | closeSession found notClosed =>
    rename_i closing _closingRecord
    by_cases same : session = closing
    · subst same
      rw [lookup] at found
      cases Option.some.inj found
      exact absurd closed notClosed
    · exact Eq.trans (tableSet_other _ _ _ same _) lookup
  | _ => exact lookup

/-- **Rotation does not retarget open Sessions.** Rotating an Environment advances its
head revision and generation and leaves every session record untouched; only future
opens see the new head. -/
theorem rotation_does_not_retarget_open_sessions {ledger environment after}
    (step : EnvironmentStep ledger (.rotate environment) after) :
    after.sessions = ledger.sessions ∧
    ∃ record, ledger.environments environment = some record ∧
      after.environments environment = some ⟨record.revision + 1, record.generation + 1⟩ := by
  cases step with
  | rotate lookup => exact ⟨rfl, _, lookup, tableSet_self ..⟩

/-- **An open pins the head active at open time.** The new session records exactly the
revision and generation the Environment head held when the open was admitted. -/
theorem open_session_pins_current_revision {ledger session environment owner token now
    restoreFrom after}
    (step : EnvironmentStep ledger
      (.openSession session environment owner token now restoreFrom) after) :
    ∃ record, ledger.environments environment = some record ∧
      after.sessions session =
        some ⟨environment, record.revision, record.generation, owner, 0, .live⟩ := by
  cases step with
  | openSession _fresh head _leaseLookup _turnEq _admits _restore =>
    exact ⟨_, head, tableSet_self ..⟩

/-- **A Session's provider pin is immutable.** Whatever transition fires, an existing
session keeps its Environment, pinned revision, pinned generation, and owning Turn; only
phase and epoch ever move. Rotation therefore cannot alias an open session onto a new
provider generation. -/
theorem session_pin_is_immutable {ledger label after session record}
    (step : EnvironmentStep ledger label after)
    (lookup : ledger.sessions session = some record) :
    ∃ current, after.sessions session = some current ∧
      current.environment = record.environment ∧ current.revision = record.revision ∧
      current.generation = record.generation ∧ current.owner = record.owner := by
  cases step with
  | openSession fresh _head _leaseLookup _turnEq _admits _restore =>
    rename_i opened _environment _owner _token _now _restoreFrom _record _lease _content
    by_cases same : session = opened
    · subst same
      rw [lookup] at fresh
      exact Option.noConfusion fresh
    · exact ⟨record, Eq.trans (tableSet_other _ _ _ same _) lookup, rfl, rfl, rfl, rfl⟩
  | markLost found _live =>
    rename_i lost _lostRecord
    by_cases same : session = lost
    · subst same
      rw [lookup] at found
      cases Option.some.inj found
      exact ⟨_, tableSet_self .., rfl, rfl, rfl, rfl⟩
    · exact ⟨record, Eq.trans (tableSet_other _ _ _ same _) lookup, rfl, rfl, rfl, rfl⟩
  | closeSession found _notClosed =>
    rename_i closing _closingRecord
    by_cases same : session = closing
    · subst same
      rw [lookup] at found
      cases Option.some.inj found
      exact ⟨_, tableSet_self .., rfl, rfl, rfl, rfl⟩
    · exact ⟨record, Eq.trans (tableSet_other _ _ _ same _) lookup, rfl, rfl, rfl, rfl⟩
  | _ => exact ⟨record, lookup, rfl, rfl, rfl, rfl⟩

/-- **Session egress is explicitly bound.** An admitted send reaches exactly the
destination its named `EgressGrant` records and attaches exactly the credential that
grant names — the proxy injects at the boundary; the Session never chooses either. -/
theorem session_egress_is_explicitly_bound {ledger use binding after}
    (step : EnvironmentStep ledger (.send use binding) after) :
    ∃ grant, ledger.egressGrants binding = some grant ∧
      after.egress =
        ⟨use.session, binding, grant.destination, grant.credential⟩ :: ledger.egress := by
  cases step with
  | send _admitted grantLookup => exact ⟨_, grantLookup, rfl⟩

/-- **An unbound send is refused.** With no `EgressGrant` recorded for the named Binding
there is no admissible send — the Session starts with no network reach of its own, and a
destination nobody passed stays unreachable (§1.5, P11-ENVIRONMENT-NO-AMBIENT-EGRESS). -/
theorem unbound_send_is_refused {ledger use binding after}
    (unbound : ledger.egressGrants binding = none) :
    ¬ EnvironmentStep ledger (.send use binding) after := by
  intro step
  cases step with
  | send _admitted grantLookup =>
    rw [unbound] at grantLookup
    exact Option.noConfusion grantLookup

/-- **The proxy send writes nothing into the Session.** The credential-carrying egress
record is the only thing a send produces; session files and snapshots are untouched, so
credential injection never lands plaintext where the agent can read it back. -/
theorem proxy_send_writes_no_session_state {ledger use binding after}
    (step : EnvironmentStep ledger (.send use binding) after) :
    after.files = ledger.files ∧ after.snapshots = ledger.snapshots := by
  cases step with
  | send _admitted _grantLookup => exact ⟨rfl, rfl⟩

def FilesIsolated (content : String → Option StoredValue) : Prop :=
  ∀ path secret, content path ≠ some (.plaintext secret)

/-- §3.5 applied to §4.5's seam: no session-visible file and no snapshot — the two faces
of the agent-visible filesystem plane — holds resolved credential plaintext. -/
def CredentialIsolated (ledger : EnvironmentLedger) : Prop :=
  (∀ session, FilesIsolated (ledger.files session)) ∧
  (∀ id record, ledger.snapshots id = some record → FilesIsolated record.content)

theorem boot_credential_isolated : CredentialIsolated .boot :=
  ⟨fun _ _ _ leak => Option.noConfusion leak, fun _ _ lookup => Option.noConfusion lookup⟩

/-- **Every transition preserves credential isolation.** Writes store agent-domain
values, which carry refs but never plaintext; a snapshot copies already-isolated files;
an open restores from an already-isolated snapshot or from empty; a close clears; the
proxy send touches no session state at all. -/
theorem env_step_preserves_credential_isolation {ledger label after}
    (isolated : CredentialIsolated ledger) (step : EnvironmentStep ledger label after) :
    CredentialIsolated after := by
  obtain ⟨files, snapshots⟩ := isolated
  cases step with
  | openSession _fresh _head _leaseLookup _turnEq _admits restore =>
    rename_i opened _environment _owner _token _now restoreFrom _record _lease content
    refine ⟨fun session path secret leak => ?_, snapshots⟩
    have leak' : setFiles ledger.files opened content session path
        = some (.plaintext secret) := leak
    by_cases same : session = opened
    · subst same
      rw [setFiles_self] at leak'
      cases restoreFrom with
      | none =>
          cases Option.some.inj restore
          exact Option.noConfusion leak'
      | some snapshotId =>
          have restore' : Option.map SnapshotRecord.content (ledger.snapshots snapshotId)
              = some content := restore
          cases snapLookup : ledger.snapshots snapshotId with
          | none =>
              rw [snapLookup] at restore'
              exact Option.noConfusion restore'
          | some record =>
              rw [snapLookup] at restore'
              cases Option.some.inj restore'
              exact snapshots snapshotId record snapLookup path secret leak'
    · rw [setFiles_other _ _ _ same] at leak'
      exact files session path secret leak'
  | write admitted =>
    rename_i use writtenPath value
    refine ⟨fun session path secret leak => ?_, snapshots⟩
    have leak' : setFiles ledger.files use.session
        (tableSet (ledger.files use.session) writtenPath value.stored) session path
        = some (.plaintext secret) := leak
    by_cases same : session = use.session
    · subst same
      rw [setFiles_self] at leak'
      by_cases samePath : path = writtenPath
      · subst samePath
        rw [tableSet_self] at leak'
        exact AgentValue.stored_is_not_plaintext value secret (Option.some.inj leak')
      · rw [tableSet_other _ _ _ samePath] at leak'
        exact files use.session path secret leak'
    · rw [setFiles_other _ _ _ same] at leak'
      exact files session path secret leak'
  | snapshot admitted fresh =>
    rename_i use snapshotId
    refine ⟨files, fun id record lookup => ?_⟩
    have lookup' : tableSet ledger.snapshots snapshotId
        ⟨use.session, ledger.files use.session⟩ id = some record := lookup
    by_cases same : id = snapshotId
    · subst same
      rw [tableSet_self] at lookup'
      cases Option.some.inj lookup'
      exact files use.session
    · rw [tableSet_other _ _ _ same] at lookup'
      exact snapshots id record lookup'
  | closeSession lookup notClosed =>
    rename_i closing _closingRecord
    refine ⟨fun session path secret leak => ?_, snapshots⟩
    have leak' : setFiles ledger.files closing (fun _ => none) session path
        = some (.plaintext secret) := leak
    by_cases same : session = closing
    · subst same
      rw [setFiles_self] at leak'
      exact Option.noConfusion leak'
    · rw [setFiles_other _ _ _ same] at leak'
      exact files session path secret leak'
  | _ => exact ⟨files, snapshots⟩

/-- **Credential isolation holds at every reachable state.** A secret a Session can use
— resolve through the proxy, name by ref, carry across snapshot and restore — is never
a value inside that Session's own state. -/
theorem reachable_credential_isolation {ledger} (reachable : EnvReachable ledger) :
    CredentialIsolated ledger := by
  induction reachable with
  | boot => exact boot_credential_isolated
  | step _ step ih => exact env_step_preserves_credential_isolation ih step

/-- **Plaintext in session state refutes reachability.** Any ledger whose session files
hold resolved credential plaintext is unreachable — the constructive form of "if
plaintext is readable in an agent-visible filesystem, the ref does not protect it"
(§3.5): the model refuses to produce such a filesystem at all. -/
theorem plaintext_in_session_state_is_unreachable {ledger session path secret}
    (leak : ledger.files session path = some (.plaintext secret)) :
    ¬ EnvReachable ledger := fun reachable =>
  (reachable_credential_isolation reachable).1 session path secret leak

/-- **A preview reaches exactly its exposed port.** An admitted preview ingress requires
a live exposure whose session is live at the exposure's exact epoch, and it reaches
exactly that session and port — the URL carries no authority beyond what the exposure
names. -/
theorem preview_ingress_is_exactly_the_exposed_port {ledger id after}
    (step : EnvironmentStep ledger (.previewIngress id) after) :
    ∃ exposure session, ledger.exposures id = some exposure ∧ exposure.live = true ∧
      ledger.sessions exposure.session = some session ∧ session.phase = .live ∧
      session.epoch = exposure.sessionEpoch ∧
      after.ingress = ⟨id, exposure.session, exposure.port⟩ :: ledger.ingress := by
  cases step with
  | previewIngress lookup live sessionLookup phase epoch =>
    exact ⟨_, _, lookup, live, sessionLookup, phase, epoch, rfl⟩

/-- **A revoked exposure fails closed.** Once revocation clears the live bit no preview
ingress is admissible through that exposure. -/
theorem revoked_exposure_admits_no_ingress {ledger id exposure after}
    (lookup : ledger.exposures id = some exposure) (revoked : exposure.live = false) :
    ¬ EnvironmentStep ledger (.previewIngress id) after := by
  intro step
  cases step with
  | previewIngress found live _sessionLookup _phase _epoch =>
    rw [lookup] at found
    cases Option.some.inj found
    rw [revoked] at live
    exact Bool.noConfusion live

/-- **A stale exposure fails closed.** An exposure whose session is lost, closed, or has
moved past the exposure's epoch admits no preview ingress, whatever its live bit says. -/
theorem stale_exposure_admits_no_ingress {ledger id exposure session after}
    (lookup : ledger.exposures id = some exposure)
    (sessionLookup : ledger.sessions exposure.session = some session)
    (stale : session.phase ≠ .live ∨ session.epoch ≠ exposure.sessionEpoch) :
    ¬ EnvironmentStep ledger (.previewIngress id) after := by
  intro step
  cases step with
  | previewIngress found live foundSession phase epoch =>
    rw [lookup] at found
    cases Option.some.inj found
    rw [sessionLookup] at foundSession
    cases Option.some.inj foundSession
    rcases stale with notLive | notEpoch
    · exact notLive phase
    · exact notEpoch epoch

end AgentCore
