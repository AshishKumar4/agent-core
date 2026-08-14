import Lean
import Lean.Util.CollectAxioms

namespace AgentCore.Normative

open Lean

def encodingVersion : String := "agent-core-lean-structure-v1"

private def jsonArray (items : List Json) : Json := .arr items.toArray

private def tagged (tag : String) (items : List Json := []) : Json :=
  jsonArray (.str tag :: items)

private def encodeNameComponent : Name → Json
  | .str .anonymous value => tagged "str" [.str value]
  | .num .anonymous value => tagged "num" [.str value.repr]
  | _ => tagged "invalid-name-component"

def encodeName (name : Name) : Json :=
  jsonArray (name.components.map encodeNameComponent)

private def levelParameterIndex (parameters : List Name) (target : Name) : Option Nat :=
  let rec visit : List Name → Nat → Option Nat
    | [], _ => none
    | parameter :: rest, index =>
      if parameter == target then some index else visit rest (index + 1)
  visit parameters 0

private def encodeLevel (parameters : List Name) : Level → Json
  | .zero => tagged "zero"
  | .succ level => tagged "succ" [encodeLevel parameters level]
  | .max left right => tagged "max" [encodeLevel parameters left, encodeLevel parameters right]
  | .imax left right => tagged "imax" [encodeLevel parameters left, encodeLevel parameters right]
  | .param name =>
    match levelParameterIndex parameters name with
    | some index => tagged "param" [.str index.repr]
    | none => tagged "free-param" [encodeName name]
  | .mvar identifier => tagged "level-mvar" [encodeName identifier.name]

private def encodeBinderInfo : BinderInfo → Json
  | .default => .str "explicit"
  | .implicit => .str "implicit"
  | .strictImplicit => .str "strict-implicit"
  | .instImplicit => .str "instance-implicit"

private def encodeLiteral : Literal → Json
  | .natVal value => tagged "nat" [.str value.repr]
  | .strVal value => tagged "string" [.str value]

def encodeExpression (levelParameters : List Name) : Expr → Json
  | .bvar index => tagged "bvar" [.str index.repr]
  | .fvar identifier => tagged "fvar" [encodeName identifier.name]
  | .mvar identifier => tagged "mvar" [encodeName identifier.name]
  | .sort level => tagged "sort" [encodeLevel levelParameters level]
  | .const name levels =>
    tagged "const" [encodeName name, jsonArray (levels.map (encodeLevel levelParameters))]
  | .app function argument =>
    tagged "app" [encodeExpression levelParameters function, encodeExpression levelParameters argument]
  | .lam _ type body binderInfo =>
    tagged "lambda" [encodeBinderInfo binderInfo, encodeExpression levelParameters type,
      encodeExpression levelParameters body]
  | .forallE _ type body binderInfo =>
    tagged "forall" [encodeBinderInfo binderInfo, encodeExpression levelParameters type,
      encodeExpression levelParameters body]
  | .letE _ type value body _ =>
    tagged "let" [encodeExpression levelParameters type, encodeExpression levelParameters value,
      encodeExpression levelParameters body]
  | .lit literal => tagged "literal" [encodeLiteral literal]
  | .mdata _ expression => encodeExpression levelParameters expression
  | .proj typeName index subject =>
    tagged "projection" [encodeName typeName, .str index.repr,
      encodeExpression levelParameters subject]

private def definitionSafety : DefinitionSafety → String
  | .safe => "safe"
  | .unsafe => "unsafe"
  | .partial => "partial"

private def encodeNames (names : List Name) : Json :=
  jsonArray (names.map encodeName)

private def encodeRecursorRule (parameters : List Name) (rule : RecursorRule) : Json :=
  tagged "rule" [encodeName rule.ctor, .str rule.nfields.repr,
    encodeExpression parameters rule.rhs]

private def encodeDeclaration (info : ConstantInfo) : Json :=
  let value := info.toConstantVal
  let header kind fields := tagged kind ([encodeName value.name, .str value.levelParams.length.repr,
    encodeExpression value.levelParams value.type] ++ fields)
  match info with
  | .axiomInfo declaration =>
    header "axiom" [.bool declaration.isUnsafe]
  | .defnInfo declaration =>
    header "definition" [.str (definitionSafety declaration.safety),
      encodeExpression declaration.levelParams declaration.value, encodeNames declaration.all]
  | .thmInfo _ => header "theorem" []
  | .opaqueInfo declaration =>
    header "opaque" [.bool declaration.isUnsafe,
      encodeExpression declaration.levelParams declaration.value, encodeNames declaration.all]
  | .quotInfo declaration =>
    let kind := match declaration.kind with
      | .type => "type"
      | .ctor => "constructor"
      | .lift => "lift"
      | .ind => "induction"
    header "quotient" [.str kind]
  | .inductInfo declaration =>
    header "inductive" [.str declaration.numParams.repr, .str declaration.numIndices.repr,
      encodeNames declaration.all, encodeNames declaration.ctors, .str declaration.numNested.repr,
      .bool declaration.isRec, .bool declaration.isUnsafe, .bool declaration.isReflexive]
  | .ctorInfo declaration =>
    header "constructor" [encodeName declaration.induct, .str declaration.cidx.repr,
      .str declaration.numParams.repr, .str declaration.numFields.repr,
      .bool declaration.isUnsafe]
  | .recInfo declaration =>
    header "recursor" [encodeNames declaration.all, .str declaration.numParams.repr,
      .str declaration.numIndices.repr, .str declaration.numMotives.repr,
      .str declaration.numMinors.repr,
      jsonArray (declaration.rules.map (encodeRecursorRule declaration.levelParams)),
      .bool declaration.k, .bool declaration.isUnsafe]

private def declarationExpressions : ConstantInfo → List Expr
  | .axiomInfo declaration => [declaration.type]
  | .defnInfo declaration => [declaration.type, declaration.value]
  | .thmInfo declaration => [declaration.type]
  | .opaqueInfo declaration => [declaration.type, declaration.value]
  | .quotInfo declaration => [declaration.type]
  | .inductInfo declaration => [declaration.type]
  | .ctorInfo declaration => [declaration.type]
  | .recInfo declaration => declaration.type :: declaration.rules.map (·.rhs)

private def structuralDependencies : ConstantInfo → List Name
  | .inductInfo declaration => declaration.all ++ declaration.ctors
  | .ctorInfo declaration => [declaration.induct]
  | .recInfo declaration => declaration.all ++ declaration.rules.map (·.ctor)
  | _ => []

private def usedConstants (expression : Expr) : List Name := Id.run do
  let mut names := []
  for name in expression.getUsedConstants do
    names := name :: names
  return names

private def hasMetavariable (expression : Expr) : Bool :=
  expression.hasExprMVar || expression.hasLevelMVar || expression.hasFVar

private structure DeclarationGraph where
  dependencies : NameMap (List Name)
  declarations : NameMap Json

private def scheduleDependencies (dependencies : List Name) (pending : List Name)
    (scheduled : NameSet) : List Name × NameSet :=
  match dependencies with
  | [] => (pending, scheduled)
  | dependency :: rest =>
    if scheduled.contains dependency then
      scheduleDependencies rest pending scheduled
    else
      scheduleDependencies rest (dependency :: pending) (scheduled.insert dependency)

private def collectDeclarationGraph (environment : Environment) (roots : List Name) :
    Except String DeclarationGraph :=
  let rec visit (fuel : Nat) (pending : List Name) (scheduled : NameSet)
      (dependencies : NameMap (List Name)) (declarations : NameMap Json) :
      Except String DeclarationGraph := do
    match fuel, pending with
    | _, [] => pure { dependencies, declarations }
    | 0, _ => throw "normative closure exceeded the imported environment"
    | fuel + 1, name :: rest =>
      let some info := environment.find? name
        | throw s!"reachable declaration {name} is absent from the environment"
      if !(`AgentCore).isPrefixOf name then
        visit fuel rest scheduled (dependencies.insert name []) declarations
      else
        let expressions := declarationExpressions info
        if expressions.any hasMetavariable then
          throw s!"reachable declaration {name} contains an open expression"
        let declarationDependencies :=
          structuralDependencies info ++ expressions.flatMap usedConstants
        let (pending, scheduled) :=
          scheduleDependencies declarationDependencies rest scheduled
        let dependencies := dependencies.insert name declarationDependencies
        match info with
        | .axiomInfo _ => throw s!"reachable AgentCore axiom {name} is forbidden"
        | .thmInfo _ => visit fuel pending scheduled dependencies declarations
        | _ =>
          visit fuel pending scheduled dependencies
            (declarations.insert name (encodeDeclaration info))
  let declarationCount := environment.constants.fold (fun count _ _ => count + 1) 0
  let (pending, scheduled) := scheduleDependencies roots [] {}
  visit (declarationCount + 1) pending scheduled {} {}

private def collectDesignationClosure (graph : DeclarationGraph) (roots : List Name) :
    Except String (List Name) :=
  let rec visit (fuel : Nat) (pending : List Name) (scheduled : NameSet)
      (names : List Name) : Except String (List Name) := do
    match fuel, pending with
    | _, [] => pure names
    | 0, _ => throw "designation closure exceeded the declaration graph"
    | fuel + 1, name :: rest =>
      match graph.dependencies.find? name with
      | none => visit fuel rest scheduled names
      | some dependencies =>
        let (pending, scheduled) := scheduleDependencies dependencies rest scheduled
        let names := if graph.declarations.contains name then name :: names else names
        visit fuel pending scheduled names
  let (pending, scheduled) := scheduleDependencies roots [] {}
  visit (graph.dependencies.toArray.size + 1) pending scheduled []

private structure Designation where
  kind : String
  name : Name

private def parseToken (token : String) : Except String (Sum String Designation) :=
  if let some value := token.dropPrefix? "allowed:" then
    pure (.inl value.toString)
  else if let some value := token.dropPrefix? "claim:" then
    pure (.inr { kind := "claim", name := value.toString.toName })
  else if let some value := token.dropPrefix? "witness:" then
    pure (.inr { kind := "witness", name := value.toString.toName })
  else
    throw s!"invalid normative export token {token}"

private def parseTokens (tokens : List String) : Except String (List String × List Designation) := do
  let mut allowed : List String := []
  let mut designations : List Designation := []
  for token in tokens do
    match ← parseToken token with
    | .inl axiomName => allowed := axiomName :: allowed
    | .inr designation => designations := designation :: designations
  if designations.isEmpty then throw "the normative export has no designations"
  if allowed.length != allowed.eraseDups.length then throw "the normative axiom allowlist has duplicates"
  let designationNames := designations.map fun designation => designation.name
  if designationNames.length != designationNames.eraseDups.length then
    throw "the normative export has duplicate designations"
  pure (allowed.reverse, designations.reverse)

private structure PreparedDesignation where
  designation : Designation
  type : Json
  axioms : List Name
  roots : List Name

private def prepareDesignation (environment : Environment) (allowed : List String)
    (designation : Designation) : CoreM PreparedDesignation := do
  let some info := environment.find? designation.name
    | throwError "designated declaration {designation.name} is absent from the environment"
  unless info.isTheorem do
    throwError "designated declaration {designation.name} is not a theorem or witness theorem"
  let axioms ← collectAxioms designation.name
  for axiomName in axioms do
    unless allowed.contains axiomName.toString do
      throwError "designated declaration {designation.name} depends on disallowed axiom {axiomName}"
  pure {
    designation,
    type := encodeExpression info.levelParams info.type,
    axioms := axioms.toList,
    roots := usedConstants info.type
  }

private def encodePreparedDesignation (graph : DeclarationGraph)
    (prepared : PreparedDesignation) : Except String Json := do
  let closure ← collectDesignationClosure graph prepared.roots
  pure (Json.mkObj [
    ("kind", .str prepared.designation.kind),
    ("name", .str prepared.designation.name.toString),
    ("type", prepared.type),
    ("axioms", jsonArray (prepared.axioms.map (fun name => .str name.toString))),
    ("closure", jsonArray (closure.map (fun name => .str name.toString)))
  ])

private def encodePackage (tokens : List String) : CoreM Json := do
  let (allowed, designations) ← match parseTokens tokens with
    | .ok value => pure value
    | .error message => throwError message
  let environment ← getEnv
  let mut preparedDesignations := []
  let mut roots := []
  for designation in designations do
    let prepared ← prepareDesignation environment allowed designation
    preparedDesignations := prepared :: preparedDesignations
    roots := prepared.roots ++ roots
  let graph ← match collectDeclarationGraph environment roots with
    | .ok value => pure value
    | .error message => throwError message
  let mut encodedDesignations := []
  for prepared in preparedDesignations.reverse do
    let encoded ← match encodePreparedDesignation graph prepared with
      | .ok value => pure value
      | .error message => throwError message
    encodedDesignations := encoded :: encodedDesignations
  let encodedDeclarations := graph.declarations.toArray.toList.map fun (name, declaration) =>
    Json.mkObj [("name", .str name.toString), ("structure", declaration)]
  pure (Json.mkObj [
    ("encodingVersion", .str encodingVersion),
    ("allowedAxioms", jsonArray (allowed.map Json.str)),
    ("designations", jsonArray encodedDesignations.reverse),
    ("declarations", jsonArray encodedDeclarations)
  ])

open Lean Elab Command in
syntax (name := agentCoreNormative) "#agent_core_normative " str+ : command

open Lean Elab Command in
elab_rules : command
  | `(#agent_core_normative $tokens:str*) => do
    let values := tokens.toList.map fun token => token.raw.isStrLit?.getD ""
    if values.any (·.isEmpty) then throwError "normative export tokens must be string literals"
    let package ← liftCoreM (encodePackage values)
    liftIO (IO.println package.compress)

end AgentCore.Normative
