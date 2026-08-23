import AgentCore
import Lean.Data.Json

/-!
# The differential-testing oracle

A line-oriented JSON server over the *executable* fragment of the formal model. The
TypeScript differential suite generates random inputs, runs them through the live
implementation, and asks this oracle for the model's answer; every function used here
is either definitionally the model (`choosePlacement`, `effectiveTier`) or proven
equivalent to the model relation (`TurnLease.admitsBool` ↔ `TurnLease.Admits`,
`leaseStepExec` ↔ `LeaseStep`, `Capability.matchesBool` ↔ `Capability.Matches`), so an
agreement failure is a genuine semantic divergence between the implementation and the
verified model.

`capability.covers` carries more than an equivalence. `capability_covering_is_sound`
proves a true answer implies the child admits no intent the parent refuses, so agreeing
with it is agreeing with SPEC §3.4 rule 2 itself, not with a restatement of the check.

`actor.activate` and `actor.admits` are likewise the modeled decisions themselves:
`ActorStep` admits an activation exactly when `activateExec` succeeds, and every
Actor-local persistence theorem is stated over that relation.

What the suites establish runs one way. A disagreement is a genuine semantic divergence
between the implementation and a proved model definition. Agreement is empirical evidence
over the inputs actually exercised and bounds nothing outside them; it is not a refinement
proof, and no designated theorem depends on any oracle run. That labelling is recorded as
`NC-DIFFERENTIAL-EMPIRICAL`.

Protocol: one JSON request per stdin line, one JSON response per stdout line.
Unknown operations and malformed requests produce `{"error": ...}` responses rather
than crashes, so a harness bug cannot masquerade as a model verdict.
-/

open Lean AgentCore

def parseTime (json : Json) : Except String Time := do
  let tick ← json.getNat?
  pure ⟨tick⟩

def parseLease (json : Json) : Except String TurnLease := do
  let turn ← (← json.getObjVal? "turn").getNat?
  let epoch ← (← json.getObjVal? "epoch").getNat?
  let expiresAt ← parseTime (← json.getObjVal? "expiresAt")
  let holderField ← json.getObjVal? "holder"
  let holder ←
    if holderField.isNull then pure none
    else do
      let tenant ← (← holderField.getObjVal? "tenant").getNat?
      let principal ← (← holderField.getObjVal? "principal").getNat?
      pure (some ⟨⟨tenant⟩, ⟨principal⟩⟩)
  pure ⟨⟨turn⟩, holder, epoch, expiresAt⟩

def parseToken (json : Json) : Except String LeaseToken := do
  let turn ← (← json.getObjVal? "turn").getNat?
  let tenant ← (← json.getObjVal? "tenant").getNat?
  let principal ← (← json.getObjVal? "principal").getNat?
  let epoch ← (← json.getObjVal? "epoch").getNat?
  pure ⟨⟨turn⟩, ⟨⟨tenant⟩, ⟨principal⟩⟩, epoch⟩

def leaseJson (lease : TurnLease) : Json :=
  Json.mkObj [
    ("turn", Json.num lease.turn.value),
    ("holder", match lease.holder with
      | none => Json.null
      | some holder => Json.mkObj [
          ("tenant", Json.num holder.tenant.value),
          ("principal", Json.num holder.id.value)]),
    ("epoch", Json.num lease.epoch),
    ("expiresAt", Json.num lease.expiresAt.tick)
  ]

def parseLabel (json : Json) : Except String LeaseLabel := do
  let kind ← (← json.getObjVal? "kind").getStr?
  match kind with
  | "claim" => do
      let holder ← parseHolder json
      pure (.claim holder (← now json) (← expiresAt json))
  | "renew" => do
      let token ← parseToken (← json.getObjVal? "token")
      pure (.renew token (← now json) (← expiresAt json))
  | "reclaim" => do
      let holder ← parseHolder json
      pure (.reclaim holder (← now json) (← expiresAt json))
  | "suspendFence" => pure .suspendFence
  | "resume" => do
      let holder ← parseHolder json
      pure (.resume holder (← now json) (← expiresAt json))
  | "terminalFence" => pure .terminalFence
  | other => throw s!"unknown lease label kind {other}"
where
  parseHolder (json : Json) : Except String PrincipalRef := do
    let tenant ← (← json.getObjVal? "tenant").getNat?
    let principal ← (← json.getObjVal? "principal").getNat?
    pure ⟨⟨tenant⟩, ⟨principal⟩⟩
  now (json : Json) : Except String Time := do parseTime (← json.getObjVal? "now")
  expiresAt (json : Json) : Except String Time := do parseTime (← json.getObjVal? "expiresAt")

def parseImpact : String → Except String InvocationImpact
  | "observe" => pure .observe
  | "mutate" => pure .mutate
  | "externalSend" => pure .externalSend
  | "execute" => pure .execute
  | "delegate" => pure .delegate
  | "administer" => pure .administer
  | other => throw s!"unknown impact {other}"

def parsePlacement : String → Except String Placement
  | "bundled" => pure .bundled
  | "provider" => pure .provider
  | "dynamic" => pure .dynamic
  | other => throw s!"unknown placement {other}"

def placementName : Placement → String
  | .bundled => "bundled" | .provider => "provider" | .dynamic => "dynamic"

def parseStringList (json : Json) : Except String (List String) := do
  let items ← json.getArr?
  items.toList.mapM Json.getStr?

/-- An intent's or capability's path projection: the canonical encoding observed at each
path. The harness supplies the projection; canonical JSON encoding and path resolution are
implementation obligations the model does not reproduce. -/
def parseProjection (json : Json) : Except String (List (ArgumentPath × CanonicalValue)) := do
  let entries ← json.getArr?
  entries.toList.mapM fun entry => do
    let segments ← parseStringList (← entry.getObjVal? "path")
    let encoded ← (← entry.getObjVal? "value").getStr?
    pure (⟨segments⟩, ⟨encoded⟩)

def parseCapability (json : Json) : Except String Capability := do
  let facetPattern ← (← json.getObjVal? "facetPattern").getStr?
  let operations ← parseStringList (← json.getObjVal? "operations")
  let impactNames ← parseStringList (← json.getObjVal? "impacts")
  let impacts ← impactNames.mapM parseImpact
  let constraints ← parseProjection (← json.getObjVal? "constraints")
  pure ⟨facetPattern.toList, operations, impacts, constraints⟩

def parseCapabilityIntent (json : Json) : Except String CapabilityIntent := do
  let facet ← (← json.getObjVal? "facet").getStr?
  let operation ← (← json.getObjVal? "operation").getStr?
  let impact ← parseImpact (← (← json.getObjVal? "impact").getStr?)
  let arguments ← parseProjection (← json.getObjVal? "arguments")
  pure ⟨facet.toList, operation, impact, arguments⟩

/-! ## Canonical JSON

`encodeJson` is the modeled encoder and `canonical_encode_injective` is proved about it, so
agreeing with `encodeCanonicalJson` here is what ties that theorem to the implementation.
Number tokens cross the boundary already rendered — the model represents a number by its
token, and rendering a JavaScript number to one is the obligation the model does not carry —
so the number leg checks only that a token is placed correctly among the delimiters. -/

partial def parseJsonTree (json : Json) : Except String JsonTree := do
  let kind ← (← json.getObjVal? "kind").getStr?
  match kind with
  | "null" => pure .null
  | "bool" => do pure (.bool (← (← json.getObjVal? "value").getBool?))
  | "num" => do pure (.num (← (← json.getObjVal? "token").getStr?).toList)
  | "str" => do pure (.str (← (← json.getObjVal? "value").getStr?).toList)
  | "arr" => do
      let items ← (← (← json.getObjVal? "items").getArr?).toList.mapM parseJsonTree
      pure (.arr items)
  | "obj" => do
      let entries ← (← (← json.getObjVal? "entries").getArr?).toList.mapM fun entry => do
        let key ← (← entry.getObjVal? "key").getStr?
        let value ← parseJsonTree (← entry.getObjVal? "value")
        pure (key.toList, value)
      pure (.obj entries)
  | other => throw s!"unknown JSON tree kind {other}"

def parseScopeRefText (json : Json) : Except String ScopeRefText := do
  let kind ← (← json.getObjVal? "kind").getStr?
  let tenant ← (← json.getObjVal? "tenant").getStr?
  match kind with
  | "tenant" => pure (.tenant tenant.toList)
  | "project" => do
      pure (.project tenant.toList (← (← json.getObjVal? "project").getStr?).toList)
  | "workspace" => do
      let projectField ← json.getObjVal? "project"
      let project ← if projectField.isNull then pure none
        else do pure (some (← projectField.getStr?).toList)
      pure (.workspace tenant.toList project (← (← json.getObjVal? "workspace").getStr?).toList)
  | other => throw s!"unknown scope kind {other}"

def parseSubjectRefText (json : Json) : Except String SubjectRefText := do
  let kind ← (← json.getObjVal? "kind").getStr?
  match kind with
  | "principal" => do
      pure (.principal (← (← json.getObjVal? "tenant").getStr?).toList
        (← (← json.getObjVal? "principal").getStr?).toList)
  | "team" => do pure (.team (← (← json.getObjVal? "team").getStr?).toList)
  | "foreign" => do
      pure (.foreign (← (← json.getObjVal? "homeTenant").getStr?).toList
        (← (← json.getObjVal? "principal").getStr?).toList
        (← (← json.getObjVal? "verifiedVia").getStr?).toList)
  | other => throw s!"unknown subject kind {other}"

/-! ## Deny precedence and Grant resolution

`evaluateExec` is the modeled decision itself. `authority_decision_is_sound` proves an
`allowed` answer implies SPEC §3.3's precedence condition over the whole intent domain, so
agreeing with it is agreeing with §3.3 rather than with a restatement of the check. Scope
and Subject identifiers cross this boundary as numbers: the implementation compares
canonical-JSON keys, and `authorityKey_injective` is what makes value comparison the right
model of that. -/

def parseScopeValue (json : Json) : Except String Scope := do
  let kind ← (← json.getObjVal? "kind").getStr?
  let tenant ← (← json.getObjVal? "tenant").getNat?
  match kind with
  | "tenant" => pure (.tenant ⟨tenant⟩)
  | "project" => do
      let project ← (← json.getObjVal? "project").getNat?
      pure (.project ⟨tenant⟩ ⟨project⟩)
  | "workspace" => do
      let projectField ← json.getObjVal? "project"
      let project ← if projectField.isNull then pure none
        else do pure (some (ProjectId.mk (← projectField.getNat?)))
      let workspace ← (← json.getObjVal? "workspace").getNat?
      pure (.workspace ⟨tenant⟩ project ⟨workspace⟩)
  | other => throw s!"unknown scope kind {other}"

def parseGuestScheme : String → Except String GuestScheme
  | "token" => pure .token
  | "callback" => pure .callback
  | "handshake" => pure .handshake
  | other => throw s!"unknown guest verification scheme {other}"

def parseSubject (json : Json) : Except String Subject := do
  let kind ← (← json.getObjVal? "kind").getStr?
  match kind with
  | "principal" => do
      let tenant ← (← json.getObjVal? "tenant").getNat?
      let principal ← (← json.getObjVal? "principal").getNat?
      pure (.principal ⟨⟨tenant⟩, ⟨principal⟩⟩)
  | "team" => do
      let team ← (← json.getObjVal? "team").getNat?
      pure (.team ⟨team⟩)
  | "foreign" => do
      let home ← (← json.getObjVal? "homeTenant").getNat?
      let principal ← (← json.getObjVal? "principal").getNat?
      let scheme ← parseGuestScheme (← (← json.getObjVal? "verifiedVia").getStr?)
      pure (.foreign ⟨home⟩ ⟨principal⟩ scheme)
  | other => throw s!"unknown subject kind {other}"

def parseGrantEffect : String → Except String GrantEffect
  | "allow" => pure .allow
  | "deny" => pure .deny
  | other => throw s!"unknown grant effect {other}"

def parseAuthorityGrant (json : Json) : Except String AuthorityGrant := do
  let id ← (← json.getObjVal? "id").getNat?
  let subject ← parseSubject (← json.getObjVal? "subject")
  let scope ← parseScopeValue (← json.getObjVal? "scope")
  let effect ← parseGrantEffect (← (← json.getObjVal? "effect").getStr?)
  let capability ← parseCapability (← json.getObjVal? "capability")
  let parentField ← json.getObjVal? "attenuationOf"
  let parent ← if parentField.isNull then pure none
    else do pure (some (GrantId.manual (← parentField.getNat?)))
  let live ← (← json.getObjVal? "live").getBool?
  pure ⟨.manual id, subject, scope, effect, capability, parent, live⟩

def parseAuthorityRequest (json : Json) : Except String AuthorityRequest := do
  let subjects ← (← (← json.getObjVal? "subjects").getArr?).toList.mapM parseSubject
  let target ← parseScopeValue (← json.getObjVal? "target")
  let intent ← parseCapabilityIntent (← json.getObjVal? "intent")
  pure ⟨subjects, target, intent⟩

def decisionName : AuthorityDecision → String
  | .allowed => "allowed"
  | .matchingDeny => "matchingDeny"
  | .guestElevation => "guestElevation"
  | .missingGrant => "missingGrant"
  | .revokedGrant => "revokedGrant"
  | .invalidDelegation => "invalidDelegation"
  | .noMatchingAllow => "noMatchingAllow"

/-! ## Actor-local persistence

`activateExec` and `admitsCommand` are the modeled decisions themselves, not mirrors of a
separate relation, and `ActorStep` admits an activation exactly when `activateExec`
succeeds. The Actor's own record log carries no part of either decision, so storage crosses
this boundary as the identity row and the fencing record only. -/

def parseActorRef (json : Json) : Except String ActorRef := do
  let kind ← (← json.getObjVal? "kind").getStr?
  let tenant ← (← json.getObjVal? "tenant").getNat?
  let id ← (← json.getObjVal? "id").getNat?
  match kind with
  | "tenant" => pure (.tenant ⟨tenant⟩)
  | "workspace" => pure (.workspace ⟨tenant⟩ ⟨id⟩)
  | "run" => pure (.run ⟨tenant⟩ ⟨id⟩)
  | other => throw s!"unknown actor kind {other}"

def actorRefJson : ActorRef → Json
  | .tenant tenant =>
      Json.mkObj [("kind", Json.str "tenant"), ("tenant", Json.num tenant.value),
        ("id", Json.num 0)]
  | .workspace tenant workspace =>
      Json.mkObj [("kind", Json.str "workspace"), ("tenant", Json.num tenant.value),
        ("id", Json.num workspace.value)]
  | .run tenant run =>
      Json.mkObj [("kind", Json.str "run"), ("tenant", Json.num tenant.value),
        ("id", Json.num run.value)]
  | .external tenant name =>
      Json.mkObj [("kind", Json.str "external"), ("tenant", Json.num tenant.value),
        ("id", Json.str name)]

def parseRecovery (json : Json) : Except String (Option ActorRecovery) := do
  if json.isNull then pure none
  else do
    let actor ← parseActorRef (← json.getObjVal? "actor")
    let epoch ← (← json.getObjVal? "epoch").getNat?
    let recoveries ← (← json.getObjVal? "recoveries").getNat?
    pure (some ⟨actor, epoch, recoveries⟩)

def recoveryJson (state : ActorRecovery) : Json :=
  Json.mkObj [("actor", actorRefJson state.actor), ("epoch", Json.num state.epoch),
    ("recoveries", Json.num state.recoveries)]

def parseFence (json : Json) : Except String ActorFence := do
  let actor ← parseActorRef (← json.getObjVal? "actor")
  let epoch ← (← json.getObjVal? "epoch").getNat?
  pure ⟨actor, epoch⟩

def parseActorStorage (json : Json) : Except String ActorStorage := do
  let identityField ← json.getObjVal? "identity"
  let identity ← if identityField.isNull then pure none
    else do pure (some (← parseActorRef identityField))
  let recovery ← parseRecovery (← json.getObjVal? "recovery")
  pure ⟨identity, recovery, []⟩

def activationFaultName : ActivationFault → String
  | .foreignActor => "foreign-actor"
  | .foreignRecovery => "foreign-recovery"
  | .missingRecoveryState => "missing-recovery-state"
  | .unboundRecoveryState => "unbound-recovery-state"

def parsePlacementSet (json : Json) : Except String PlacementSet := do
  let bundled ← (← json.getObjVal? "bundled").getBool?
  let provider ← (← json.getObjVal? "provider").getBool?
  let dynamic ← (← json.getObjVal? "dynamic").getBool?
  pure ⟨bundled, provider, dynamic⟩

structure OracleOperation where
  name : String
  definitions : List Name
  handle : Json → Except String Json

private def oracleOperations : List OracleOperation :=
  [
    ⟨"lease.admits", [`AgentCore.TurnLease.admitsBool], fun request => do
        let lease ← parseLease (← request.getObjVal? "lease")
        let token ← parseToken (← request.getObjVal? "token")
        let now ← parseTime (← request.getObjVal? "now")
        pure (Json.mkObj [("admits", Json.bool (lease.admitsBool token now))])⟩,
    ⟨"lease.step", [`AgentCore.leaseStepExec], fun request => do
        let lease ← parseLease (← request.getObjVal? "lease")
        let label ← parseLabel (← request.getObjVal? "label")
        match leaseStepExec lease label with
        | some after => pure (Json.mkObj [("ok", Json.bool true), ("after", leaseJson after)])
        | none => pure (Json.mkObj [("ok", Json.bool false)])⟩,
    ⟨"policy.tier", [`AgentCore.effectiveTier], fun request => do
        let impact ← parseImpact (← (← request.getObjVal? "impact").getStr?)
        let sessionScoped ← (← request.getObjVal? "sessionScoped").getBool?
        let placement ← parsePlacement (← (← request.getObjVal? "placement").getStr?)
        let intercepted ← (← request.getObjVal? "intercepted").getBool?
        let tier := effectiveTier placement impact sessionScoped intercepted
        pure (Json.mkObj [("tier", Json.str (match tier with
          | .direct => "direct" | .mediated => "mediated"))])⟩,
    ⟨"capability.matches", [`AgentCore.Capability.matchesBool], fun request => do
        let spec ← parseCapability (← request.getObjVal? "capability")
        let intent ← parseCapabilityIntent (← request.getObjVal? "intent")
        pure (Json.mkObj [("matches", Json.bool (spec.matchesBool intent))])⟩,
    ⟨"capability.covers", [`AgentCore.Capability.coversBool], fun request => do
        let parent ← parseCapability (← request.getObjVal? "parent")
        let child ← parseCapability (← request.getObjVal? "child")
        pure (Json.mkObj [("covers", Json.bool (parent.coversBool child))])⟩,
    ⟨"json.canonical", [`AgentCore.encodeJson], fun request => do
        let tree ← parseJsonTree (← request.getObjVal? "value")
        pure (Json.mkObj [("encoded", Json.str (String.mk (encodeJson tree)))])⟩,
    ⟨"authority.scopeKey", [`AgentCore.scopeKeyText], fun request => do
        let scope ← parseScopeRefText (← request.getObjVal? "scope")
        pure (Json.mkObj [("key", Json.str (String.mk (scopeKeyText scope)))])⟩,
    ⟨"authority.subjectKey", [`AgentCore.subjectKeyText], fun request => do
        let subject ← parseSubjectRefText (← request.getObjVal? "subject")
        pure (Json.mkObj [("key", Json.str (String.mk (subjectKeyText subject)))])⟩,
    ⟨"authority.evaluate", [`AgentCore.evaluateExec], fun request => do
        let grants ← (← (← request.getObjVal? "grants").getArr?).toList.mapM parseAuthorityGrant
        let evaluated ← parseAuthorityRequest (← request.getObjVal? "request")
        let guest ← (← request.getObjVal? "guest").getBool?
        let backing ← (← request.getObjVal? "backing").getNat?
        pure (Json.mkObj [("decision",
          Json.str (decisionName (evaluateExec ⟨grants, evaluated, guest, .manual backing⟩)))])⟩,
    ⟨"actor.activate", [`AgentCore.activateExec], fun request => do
        let storage ← parseActorStorage (← request.getObjVal? "storage")
        let actor ← parseActorRef (← request.getObjVal? "actor")
        match activateExec storage actor with
        | .ok (next, activation) =>
            pure (Json.mkObj [
              ("ok", Json.bool true),
              ("kind", Json.str (match activation.kind with
                | .created => "created" | .recovered => "recovered")),
              ("recovery", match next.recovery with
                | none => Json.null
                | some state => recoveryJson state)])
        | .error fault =>
            pure (Json.mkObj [("ok", Json.bool false),
              ("fault", Json.str (activationFaultName fault))])⟩,
    ⟨"actor.admits", [`AgentCore.admitsCommand], fun request => do
        let self ← parseActorRef (← request.getObjVal? "self")
        let held ← parseFence (← request.getObjVal? "held")
        let expectedField ← request.getObjVal? "expected"
        let expected ← if expectedField.isNull then pure none
          else do pure (some (← parseFence expectedField))
        let stored ← parseRecovery (← request.getObjVal? "stored")
        pure (Json.mkObj [("admits", Json.bool (admitsCommand self held expected stored))])⟩,
    ⟨"policy.placement", [`AgentCore.choosePlacement], fun request => do
        let manifest ← parsePlacementSet (← request.getObjVal? "manifest")
        let policy ← parsePlacementSet (← request.getObjVal? "policy")
        let substrate ← parsePlacementSet (← request.getObjVal? "substrate")
        let trust ← parsePlacementSet (← request.getObjVal? "trust")
        pure (Json.mkObj [("selected", match choosePlacement manifest policy substrate trust with
          | none => Json.null
          | some placement => Json.str (placementName placement))])⟩
  ]

private def operationManifest : Json :=
  .arr (oracleOperations.map (fun operation => Json.mkObj [
    ("op", Json.str operation.name),
    ("definitions", .arr (operation.definitions.map (fun name => Json.str name.toString)).toArray)
  ])).toArray

def respond (request : Json) : Json :=
  match handle request with
  | .ok response => response
  | .error message => Json.mkObj [("error", Json.str message)]
where
  handle (request : Json) : Except String Json := do
    let name ← (← request.getObjVal? "op").getStr?
    let some operation := oracleOperations.find? (·.name == name)
      | throw s!"unknown op {name}"
    operation.handle request

partial def serve (stream : IO.FS.Stream) : IO Unit := do
  let line ← stream.getLine
  if line.isEmpty then
    return ()
  let response :=
    match Json.parse line with
    | .ok request => respond request
    | .error message => Json.mkObj [("error", Json.str s!"parse: {message}")]
  IO.println response.compress
  (← IO.getStdout).flush
  serve stream

def main (arguments : List String) : IO UInt32 := do
  match arguments with
  | ["--operations"] =>
    IO.println operationManifest.compress
    pure 0
  | [] =>
    serve (← IO.getStdin)
    pure 0
  | _ =>
    IO.eprintln "usage: oracle [--operations]"
    pure 64
