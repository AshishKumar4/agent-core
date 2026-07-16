import AgentCore
import Lean.Data.Json

/-!
# The differential-testing oracle

A line-oriented JSON server over the *executable* fragment of the formal model. The
TypeScript differential suite generates random inputs, runs them through the live
implementation, and asks this oracle for the model's answer; every function used here
is either definitionally the model (`choosePlacement`, `effectiveTier`) or proven
equivalent to the model relation (`TurnLease.admitsBool` ↔ `TurnLease.Admits`,
`leaseStepExec` ↔ `LeaseStep`), so an agreement failure is a genuine semantic
divergence between the implementation and the verified model.

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

def parsePlacementSet (json : Json) : Except String PlacementSet := do
  let bundled ← (← json.getObjVal? "bundled").getBool?
  let provider ← (← json.getObjVal? "provider").getBool?
  let dynamic ← (← json.getObjVal? "dynamic").getBool?
  pure ⟨bundled, provider, dynamic⟩

def respond (request : Json) : Json :=
  match handle request with
  | .ok response => response
  | .error message => Json.mkObj [("error", Json.str message)]
where
  handle (request : Json) : Except String Json := do
    let op ← (← request.getObjVal? "op").getStr?
    match op with
    | "lease.admits" => do
        let lease ← parseLease (← request.getObjVal? "lease")
        let token ← parseToken (← request.getObjVal? "token")
        let now ← parseTime (← request.getObjVal? "now")
        pure (Json.mkObj [("admits", Json.bool (lease.admitsBool token now))])
    | "lease.step" => do
        let lease ← parseLease (← request.getObjVal? "lease")
        let label ← parseLabel (← request.getObjVal? "label")
        match leaseStepExec lease label with
        | some after => pure (Json.mkObj [("ok", Json.bool true), ("after", leaseJson after)])
        | none => pure (Json.mkObj [("ok", Json.bool false)])
    | "policy.tier" => do
        let impact ← parseImpact (← (← request.getObjVal? "impact").getStr?)
        let sessionScoped ← (← request.getObjVal? "sessionScoped").getBool?
        let placement ← parsePlacement (← (← request.getObjVal? "placement").getStr?)
        let tier := effectiveTier placement impact sessionScoped
        pure (Json.mkObj [("tier", Json.str (match tier with
          | .direct => "direct" | .mediated => "mediated"))])
    | "policy.placement" => do
        let manifest ← parsePlacementSet (← request.getObjVal? "manifest")
        let policy ← parsePlacementSet (← request.getObjVal? "policy")
        let substrate ← parsePlacementSet (← request.getObjVal? "substrate")
        let trust ← parsePlacementSet (← request.getObjVal? "trust")
        pure (Json.mkObj [("selected", match choosePlacement manifest policy substrate trust with
          | none => Json.null
          | some placement => Json.str (placementName placement))])
    | other => throw s!"unknown op {other}"

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

def main : IO Unit := do
  serve (← IO.getStdin)
