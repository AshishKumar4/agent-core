import SpecCnl.Intent.Adversarial

/-!
# The bounded search

The untrusted half of the contradiction checker, and the only untrusted component in this
instrument. It proposes; it never decides.

What it does. For each permission of a record it looks for one transition inside
`rmax bound safety` that realises the permission, enumerating the ledger's declared window
in the ledger's declared order. `sat_iff_rmax` is what makes that the whole question: under
a bound, an intent with pointwise safety atoms and upward-closed permissions is satisfiable
exactly when every permission holds of that one relation, so there is nothing to search over
but transitions.

Why it may be untrusted. Its answer is checked twice and believed neither time. It is
compared against the record's own expected verdict, and the verdict it agrees on has to be
inhabited by a named theorem whose type is the claim the record owns — see
`SpecCnl.Intent.Proofs` and the shape check in `SpecCnl.Intent.Report`. A wrong mirror
produces a wrong proposal, the proposal disagrees with the record, and the build fails. A
wrong mirror that happens to agree still leaves the verdict resting on the kernel, because
the theorem is about the *elaborated atoms* and not about the mirror.

What it is not. It never reports CONSISTENT from exhaustion: a CONSISTENT proposal is a
found instance, which is a proof obligation for an existential and needs no bound at all. A
no-witness result is bounded, and it is a proposal that a universal refutation then has to
close. So no verdict in stage 1 is ever "true within the bounds".
-/

namespace SpecCnl.Intent.Search

open AgentCore

/-- The Bool mirror of one reviewed atom. -/
structure Probe (σ lab : Type) where
  /-- The atom this mirrors. -/
  key : String
  polarity : Polarity
  guard : σ → lab → Bool
  /-- The condition, mirrored. `true` where the atom's condition is vacuous, which is what a
  lifted payload condition is for a label of another constructor. -/
  cond : σ → lab → Bool

/-- Which relation the search treats as the upper bound. -/
inductive Bound where
  /-- Every conceivable platform: `anyTransition`. -/
  | universe
  /-- The ledger's own step relation, reached through its executable mirror. -/
  | model
  deriving DecidableEq, Repr, Inhabited

/-- The finite window to enumerate, and the mirror that computes a successor state. -/
structure Space (σ lab : Type) where
  states : List σ
  labels : List lab
  exec : σ → lab → Option σ
  render : σ → lab → String

/-- Whether every safety atom's mirror accepts this transition. -/
def satisfies {σ lab : Type} (safety : List (Probe σ lab)) (before : σ) (label : lab) : Bool :=
  safety.all (fun atom => !atom.guard before label || atom.cond before label)

/-- Whether the bound admits this transition at all. Under `model` that is the executable
mirror answering; `leaseStepExec_sound` is what turns its answer into a step of the
relation, and the witness theorem is where that happens. -/
def admits {σ lab : Type} (space : Space σ lab) (bound : Bound) (before : σ) (label : lab) :
    Bool :=
  match bound with
  | .universe => true
  | .model => (space.exec before label).isSome

/-- The least transition in the window that the bound admits, every safety mirror accepts,
and the permission selects.

Enumeration is states outer and labels inner, each in the order the ledger row declares, so
"least" means least under that order and the row pins it. -/
def firstWitness {σ lab : Type} (space : Space σ lab) (bound : Bound)
    (safety : List (Probe σ lab)) (permission : Probe σ lab) : Option (σ × lab) :=
  space.states.findSome? (fun before =>
    (space.labels.find? (fun label =>
        admits space bound before label && satisfies safety before label &&
          permission.guard before label && permission.cond before label)).map
      (fun label => (before, label)))

/-- A 1-minimal unsat core, by deletion: drop one safety atom at a time and keep the drop
whenever the bounded search still finds no witness.

The core is not a review aid. `not_permission_of_core` transfers a refutation at the core to
the whole safety set, and a record's refutation proof is stated at its core, so the core the
search reports is the core the proof went through. -/
def minimalCore {σ lab : Type} (space : Space σ lab) (bound : Bound)
    (safety : List (Probe σ lab)) (permission : Probe σ lab) : List (Probe σ lab) :=
  safety.foldl
    (fun current atom =>
      let trial := current.filter (fun kept => kept.key != atom.key)
      if (firstWitness space bound trial permission).isNone then trial else current)
    safety

/-- What the search proposes for one record. -/
structure Outcome where
  verdict : Verdict
  /-- The permission that found no witness, when one did not. -/
  failed : Option String
  /-- Atom keys of the 1-minimal core that excludes it. -/
  core : List String
  /-- The least instance the failed permission accepts under the bound *alone*, so a
  reviewer sees exactly what the core excluded. -/
  excluded : Option String
  /-- Per permission, the least instance inside `rmax step safety` that realises it. -/
  witnesses : List (String × String)
  /-- How many candidate transitions the window holds. -/
  explored : Nat
  deriving Repr, Inhabited

/-- The algorithm of the brief, run over one window.

A structural branch would come first — an intent whose relation-free facts are already false
of the ontology is OUTSIDE-MODEL before any relation is considered — but no stage-1
connective can produce a relation-free atom, so there is nothing for that branch to test and
it is not written. -/
def outcome {σ lab : Type} (space : Space σ lab) (probes : List (Probe σ lab)) : Outcome :=
  let safety := probes.filter (fun atom => atom.polarity == Polarity.safety)
  let permissions := probes.filter (fun atom => atom.polarity == Polarity.permission)
  let explored := space.states.length * space.labels.length
  let show? (found : Option (σ × lab)) : Option String :=
    found.map (fun (before, label) => space.render before label)
  let failing (bound : Bound) : Option (Probe σ lab) :=
    permissions.find? (fun permission => (firstWitness space bound safety permission).isNone)
  let report (bound : Bound) (verdict : Verdict) (permission : Probe σ lab) : Outcome :=
    { verdict
      failed := some permission.key
      core := (minimalCore space bound safety permission).map Probe.key
      excluded := show? (firstWitness space bound [] permission)
      witnesses := []
      explored }
  match failing .universe with
  | some permission => report .universe .inconsistent permission
  | none =>
      match failing .model with
      | some permission => report .model .outsideModel permission
      | none =>
          { verdict := .consistent
            failed := none
            core := []
            excluded := none
            witnesses := permissions.filterMap (fun permission =>
              (show? (firstWitness space .model safety permission)).map
                (fun instance? => (permission.key, instance?)))
            explored }

/-! ## The Turn-lease window

Generated from `leaseWindow`, so the numbers the search explores and the numbers the pin
records are the same numbers. -/

private def upto (low high : Nat) : List Nat :=
  (List.range (high + 1 - low)).map (fun step => low + step)

private def principals : List PrincipalRef :=
  (upto 0 leaseWindow.principals).map (fun id => ⟨⟨0⟩, ⟨id⟩⟩)

private def moments : List Time := (upto 0 leaseWindow.times).map (fun tick => ⟨tick⟩)

private def deadlines : List Time := (upto 1 leaseWindow.expiries).map (fun tick => ⟨tick⟩)

private def tokens : List LeaseToken :=
  (upto 0 leaseWindow.turns).flatMap (fun turn =>
    principals.flatMap (fun holder =>
      (upto 0 leaseWindow.epochs).map (fun epoch => ⟨⟨turn⟩, holder, epoch⟩)))

def leaseStates : List TurnLease :=
  (upto 0 leaseWindow.turns).flatMap (fun turn =>
    (none :: principals.map some).flatMap (fun holder =>
      (upto 0 leaseWindow.epochs).flatMap (fun epoch =>
        (upto 1 leaseWindow.expiries).map (fun expiry => ⟨⟨turn⟩, holder, epoch, ⟨expiry⟩⟩))))

/-- Every label of every constructor in the window, constructors in declaration order. A
permission over a guard this instrument has no entry for yet would still be searched for
honestly. -/
def leaseLabels : List LeaseLabel :=
  principals.flatMap (fun holder =>
      moments.flatMap (fun now => deadlines.map (fun ends => .claim holder now ends))) ++
    tokens.flatMap (fun token =>
      moments.flatMap (fun now => deadlines.map (fun ends => .renew token now ends))) ++
    principals.flatMap (fun holder =>
      moments.flatMap (fun now => deadlines.map (fun ends => .reclaim holder now ends))) ++
    [.suspendFence] ++
    principals.flatMap (fun holder =>
      moments.flatMap (fun now => deadlines.map (fun ends => .resume holder now ends))) ++
    [.terminalFence]

private def renderHolder : Option PrincipalRef → String
  | none => "none"
  | some holder => s!"{holder.tenant.value}.{holder.id.value}"

/-- One transition, as the pin records it. Deliberately not `Repr`: the pin is compared
byte for byte, so the rendering has to be stable and readable rather than derived. -/
def renderTransition (lease : TurnLease) (label : LeaseLabel) : String :=
  let state :=
    s!"lease(turn={lease.turn.value}, holder={renderHolder lease.holder}, \
       epoch={lease.epoch}, expiry={lease.expiresAt.tick})"
  let event :=
    match label with
    | .claim holder now ends =>
        s!"claim(holder={renderHolder (some holder)}, now={now.tick}, expiresAt={ends.tick})"
    | .renew token now ends =>
        s!"renew(turn={token.turn.value}, holder={renderHolder (some token.holder)}, \
           epoch={token.epoch}, now={now.tick}, expiresAt={ends.tick})"
    | .reclaim holder now ends =>
        s!"reclaim(holder={renderHolder (some holder)}, now={now.tick}, \
           expiresAt={ends.tick})"
    | .suspendFence => "suspendFence"
    | .resume holder now ends =>
        s!"resume(holder={renderHolder (some holder)}, now={now.tick}, expiresAt={ends.tick})"
    | .terminalFence => "terminalFence"
  s!"{state} -- {event}"

def leaseSpace : Space TurnLease LeaseLabel :=
  { states := leaseStates
    labels := leaseLabels
    exec := AgentCore.leaseStepExec
    render := renderTransition }

/-! ## The mirrors

One per reviewed atom, and each sits beside the sentence it mirrors so review is local. The
guard of every stage-1 atom is the reclaim constructor; a condition lifted under
`for the reclaim` is vacuous for any other constructor, and the mirrors say so. -/

private def isReclaim : LeaseLabel → Bool
  | .reclaim _ _ _ => true
  | _ => false

def leaseProbes : List (Probe TurnLease LeaseLabel) :=
  [ { key := "LEASE_EXPIRY_BOUND"
      polarity := .safety
      guard := fun _ label => isReclaim label
      cond := fun lease label =>
        match label with
        | .reclaim _ now _ => lease.expiresAt.tick ≤ now.tick
        | _ => true },
    { key := "LEASE_RECLAIM_POSSIBLE"
      polarity := .permission
      guard := fun _ label => isReclaim label
      cond := fun _ _ => true },
    { key := "LEASE_RECLAIM_UNHELD"
      polarity := .safety
      guard := fun _ label => isReclaim label
      cond := fun lease _ => lease.holder == none },
    { key := "LEASE_RECLAIM_BY_TWO"
      polarity := .safety
      guard := fun _ label => isReclaim label
      cond := fun _ label =>
        match label with
        | .reclaim _ now _ => now.tick ≤ 2
        | _ => true },
    { key := "LEASE_RECLAIM_AT_THREE"
      polarity := .permission
      guard := fun _ label => isReclaim label
      cond := fun _ label =>
        match label with
        | .reclaim _ now _ => now.tick == 3
        | _ => true } ]

def probeWithKey? (key : String) : Option (Probe TurnLease LeaseLabel) :=
  leaseProbes.find? (fun probe => probe.key == key)

/-! ## Per-record verdicts -/

/-- The mirrors of a record's atoms, in the record's own order. -/
def probesFor (record : IntentRecord) : Except String (List (Probe TurnLease LeaseLabel)) := do
  if record.ledger != leaseLedger.key then
    throw s!"intent record '{record.key}' is over ledger '{record.ledger}', which has no \
             search window"
  let mut probes : List (Probe TurnLease LeaseLabel) := []
  for key in record.atoms do
    match probeWithKey? key with
    | none => throw s!"atom '{key}' has no search mirror"
    | some probe => probes := probes ++ [probe]
  return probes

/-- What the search proposes for a record. -/
def observed (record : IntentRecord) : Except String Outcome := do
  return outcome leaseSpace (← probesFor record)

/-- Refusals of the mirrors themselves: an atom with no mirror, a mirror for no atom, or a
mirror whose declared polarity is not the atom's. -/
def probeRefusals : List String := Id.run do
  let mut refusals : List String := []
  for atom in atoms do
    if atom.ledger == leaseLedger.key then
      match probeWithKey? atom.key with
      | none => refusals := refusals ++ [s!"atom '{atom.key}' has no search mirror"]
      | some probe =>
          if probe.polarity != atom.polarity then
            refusals := refusals ++
              [s!"the search mirror of '{atom.key}' is {probe.polarity.render} but the atom \
                  is {atom.polarity.render}"]
  for probe in leaseProbes do
    if (atomWithKey? probe.key).isNone then
      refusals := refusals ++ [s!"search mirror '{probe.key}' mirrors no reviewed atom"]
  return refusals

/-- Records whose proposed verdict is not the one they expect. A drift here fails the build:
a contradiction that stops being detected, or a model refusal that turns into a witness, is
exactly what this list exists to catch. -/
def verdictRefusals : List String :=
  allRecords.filterMap (fun record =>
    match observed record with
    | .error message => some s!"intent record '{record.key}': {message}"
    | .ok found =>
        if found.verdict == record.expected then none
        else some
          s!"intent record '{record.key}' expects {record.expected.render} but the search \
             proposes {found.verdict.render}")

end SpecCnl.Intent.Search
