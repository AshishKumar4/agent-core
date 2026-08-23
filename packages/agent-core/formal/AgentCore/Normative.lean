import Lean
import Lean.Util.CollectAxioms

namespace AgentCore.Normative

open Lean

def encodingVersion : String := "agent-core-lean-structure-v2"

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

private structure SemanticEncoding where
  json : Json
  dependencies : List Name := []

private def localIndex? (locals : List FVarId) (target : FVarId) : Option Nat :=
  let rec visit : List FVarId → Nat → Option Nat
    | [], _ => none
    | fvarId :: rest, index =>
      if fvarId == target then some index else visit rest (index + 1)
  visit locals 0

private def encodeSemanticExpression (levelParameters : List Name)
    (locals : List FVarId) (expression : Expr) : MetaM SemanticEncoding := do
  let rec visit (fuel : Nat) (locals : List FVarId)
      (expression : Expr) : MetaM SemanticEncoding := do
    match fuel with
    | 0 => throwError "semantic expression exceeded its structural size bound"
    | fuel + 1 =>
      if ← Meta.isProof expression then
        return { json := tagged "proof" }
      match expression with
      | .bvar index =>
        throwError "semantic encoder encountered uninstantiated bound variable {index}"
      | .fvar identifier =>
        let some index := localIndex? locals identifier
          | throwError "semantic encoder encountered an unbound free variable"
        pure { json := tagged "bvar" [.str index.repr] }
      | .mvar identifier =>
        throwError "semantic encoder encountered metavariable {identifier.name}"
      | .sort level => pure { json := tagged "sort" [encodeLevel levelParameters level] }
      | .const name levels =>
        pure {
          json := tagged "const" [encodeName name,
            jsonArray (levels.map (encodeLevel levelParameters))]
          dependencies := [name]
        }
      | .app function argument =>
        let function ← visit fuel locals function
        let argument ← visit fuel locals argument
        pure {
          json := tagged "app" [function.json, argument.json]
          dependencies := function.dependencies ++ argument.dependencies
        }
      | .lam name type body binderInfo =>
        let typeEncoding ← visit fuel locals type
        Meta.withLocalDecl name binderInfo type fun fvar => do
          let bodyEncoding ← visit fuel (fvar.fvarId! :: locals) (body.instantiate1 fvar)
          pure {
            json := tagged "lambda" [encodeBinderInfo binderInfo, typeEncoding.json,
              bodyEncoding.json]
            dependencies := typeEncoding.dependencies ++ bodyEncoding.dependencies
          }
      | .forallE name type body binderInfo =>
        let typeEncoding ← visit fuel locals type
        Meta.withLocalDecl name binderInfo type fun fvar => do
          let bodyEncoding ← visit fuel (fvar.fvarId! :: locals) (body.instantiate1 fvar)
          pure {
            json := tagged "forall" [encodeBinderInfo binderInfo, typeEncoding.json,
              bodyEncoding.json]
            dependencies := typeEncoding.dependencies ++ bodyEncoding.dependencies
          }
      | .letE name type value body _ =>
        let typeEncoding ← visit fuel locals type
        let valueEncoding ← visit fuel locals value
        Meta.withLetDecl name type value fun fvar => do
          let bodyEncoding ← visit fuel (fvar.fvarId! :: locals) (body.instantiate1 fvar)
          pure {
            json := tagged "let" [typeEncoding.json, valueEncoding.json, bodyEncoding.json]
            dependencies := typeEncoding.dependencies ++ valueEncoding.dependencies ++
              bodyEncoding.dependencies
          }
      | .lit literal => pure { json := tagged "literal" [encodeLiteral literal] }
      | .mdata _ inner => visit fuel locals inner
      | .proj typeName index subject =>
        let subject ← visit fuel locals subject
        pure {
          json := tagged "projection" [encodeName typeName, .str index.repr, subject.json]
          dependencies := typeName :: subject.dependencies
        }
  visit (expression.sizeWithoutSharing + 1) locals expression

private def encodeRecursorRule (parameters : List Name)
    (rule : RecursorRule) : MetaM (Json × List Name) := do
  let rhs ← encodeSemanticExpression parameters [] rule.rhs
  pure (tagged "rule" [encodeName rule.ctor, .str rule.nfields.repr, rhs.json],
    rhs.dependencies)

private structure DeclarationEncoding where
  json : Option Json
  dependencies : List Name

private def encodeDeclaration (info : ConstantInfo) : MetaM DeclarationEncoding := do
  let value := info.toConstantVal
  let encodedType ← encodeSemanticExpression value.levelParams [] value.type
  let header kind fields := tagged kind ([encodeName value.name, .str value.levelParams.length.repr,
    encodedType.json] ++ fields)
  let typeDependencies := encodedType.dependencies
  match info with
  | .axiomInfo declaration =>
    pure {
      json := some (header "axiom" [.bool declaration.isUnsafe])
      dependencies := typeDependencies
    }
  | .defnInfo declaration =>
    let encodedValue ← encodeSemanticExpression declaration.levelParams [] declaration.value
    pure {
      json := some (header "definition" [.str (definitionSafety declaration.safety),
        encodedValue.json, encodeNames declaration.all])
      dependencies := typeDependencies ++ encodedValue.dependencies
    }
  | .thmInfo _ => pure { json := none, dependencies := typeDependencies }
  | .opaqueInfo declaration =>
    let encodedValue ← encodeSemanticExpression declaration.levelParams [] declaration.value
    pure {
      json := some (header "opaque" [.bool declaration.isUnsafe,
        encodedValue.json, encodeNames declaration.all])
      dependencies := typeDependencies ++ encodedValue.dependencies
    }
  | .quotInfo declaration =>
    let kind := match declaration.kind with
      | .type => "type"
      | .ctor => "constructor"
      | .lift => "lift"
      | .ind => "induction"
    pure {
      json := some (header "quotient" [.str kind])
      dependencies := typeDependencies
    }
  | .inductInfo declaration =>
    pure {
      json := some (header "inductive" [.str declaration.numParams.repr,
        .str declaration.numIndices.repr, encodeNames declaration.all,
        encodeNames declaration.ctors, .str declaration.numNested.repr,
        .bool declaration.isRec, .bool declaration.isUnsafe, .bool declaration.isReflexive])
      dependencies := typeDependencies
    }
  | .ctorInfo declaration =>
    pure {
      json := some (header "constructor" [encodeName declaration.induct,
        .str declaration.cidx.repr, .str declaration.numParams.repr,
        .str declaration.numFields.repr, .bool declaration.isUnsafe])
      dependencies := typeDependencies
    }
  | .recInfo declaration =>
    let encodedRules ← declaration.rules.mapM (encodeRecursorRule declaration.levelParams)
    pure {
      json := some (header "recursor" [encodeNames declaration.all,
        .str declaration.numParams.repr, .str declaration.numIndices.repr,
        .str declaration.numMotives.repr, .str declaration.numMinors.repr,
        jsonArray (encodedRules.map (·.1)), .bool declaration.k,
        .bool declaration.isUnsafe])
      dependencies := typeDependencies ++ encodedRules.flatMap (·.2)
    }

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

private def hasForbiddenSafety : ConstantInfo → Bool
  | .axiomInfo declaration => declaration.isUnsafe
  | .defnInfo declaration => declaration.safety != .safe
  | .thmInfo _ => false
  | .opaqueInfo declaration => declaration.isUnsafe
  | .quotInfo _ => false
  | .inductInfo declaration => declaration.isUnsafe
  | .ctorInfo declaration => declaration.isUnsafe
  | .recInfo declaration => declaration.isUnsafe

private def hasMetavariable (expression : Expr) : Bool :=
  expression.hasExprMVar || expression.hasLevelMVar || expression.hasFVar

private def isCompilerAuxiliaryComponent (value : String) : Bool :=
  (value.startsWith "_elambda_" && (value.drop 9).isNat) ||
    (value.startsWith "_spec_" && (value.drop 6).isNat)

private def hasCompilerAuxiliaryName : Name → Bool
  | .str parent value =>
      isCompilerAuxiliaryComponent value || hasCompilerAuxiliaryName parent
  | .num parent _ => hasCompilerAuxiliaryName parent
  | .anonymous => false

private def isCompilerAuxiliaryAxiom (name : Name) : CoreM Bool := do
  if !hasCompilerAuxiliaryName name then return false
  return (← findDeclarationRangesCore? name).isNone

private def userDeclarationName (name : Name) : Name :=
  (privateToUserName? name).getD name

private def isProjectModuleDeclaration (environment : Environment) (name : Name) : Bool :=
  match environment.getModuleIdxFor? name with
    | none => true
    | some moduleIndex =>
      match environment.allImportedModuleNames[moduleIndex.toNat]? with
      | none => true
      | some moduleName => (`AgentCore).isPrefixOf moduleName

private def isProjectDeclarationName (environment : Environment) (name : Name) : Bool :=
  !(userDeclarationName name).isInternal && isProjectModuleDeclaration environment name

private def collectAxiomUnion [Monad m] [MonadEnv m] (roots : List Name) : m (Array Name) :=
  roots.foldlM (init := #[]) fun union root => do
    let axioms ← collectAxioms root
    pure (union ++ axioms)

private def axiomIsAllowed (allowed : List String) (name : Name) : Bool :=
  let value := name.toString
  value != "Lean.ofReduceBool" && value != "sorryAx" && allowed.contains value

private def auditProjectEnvironment (environment : Environment)
    (allowed : List String) : CoreM Unit := do
  let declarations := environment.constants.fold
    (fun declarations name info => declarations.push (name, info)) #[]
    |>.qsort (Name.quickLt ·.1 ·.1)
  for (name, info) in declarations do
    match info, Compiler.isUnsafeRecName? name with
    | .defnInfo declaration, some sourceName =>
      let sourceIsOpaque := match environment.find? sourceName with
        | some (.opaqueInfo _) => true
        | _ => false
      if declaration.safety == .partial && sourceIsOpaque &&
          isProjectDeclarationName environment sourceName then
        throwError "project declaration {userDeclarationName sourceName} is unsafe or partial"
    | _, _ => pure ()
  for (name, info) in declarations do
    if isProjectModuleDeclaration environment name then
      match info with
      | .axiomInfo _ =>
        unless ← isCompilerAuxiliaryAxiom name do
          throwError "project declaration {userDeclarationName name} is a forbidden custom axiom"
      | _ => pure ()
  let theoremNames := declarations.foldl (init := []) fun names (name, info) =>
    if isProjectDeclarationName environment name && info.isTheorem then name :: names else names
  for axiomName in ← collectAxiomUnion theoremNames do
    unless axiomIsAllowed allowed axiomName do
      throwError "project theorem set depends on disallowed axiom {axiomName}"
  for (name, info) in declarations do
    if isProjectDeclarationName environment name then
      if hasForbiddenSafety info then
        throwError "project declaration {userDeclarationName name} is unsafe or partial"
      let expressions := declarationExpressions info
      if expressions.any hasMetavariable then
        throwError "project declaration {userDeclarationName name} contains an open expression"
  let definitionNames := declarations.foldl (init := []) fun names (name, info) =>
    if isProjectDeclarationName environment name && !info.isTheorem then name :: names else names
  for axiomName in ← collectAxiomUnion definitionNames do
    unless axiomIsAllowed allowed axiomName do
      throwError "project definition set depends on disallowed axiom {axiomName}"

private structure DeclarationGraph where
  dependencies : NameMap (List Name)
  declarations : NameMap Json

private def scheduleDependencies (dependencies : List Name) (pending : List Name)
    (scheduled : NameSet) : List Name × NameSet := Id.run do
  let mut pending := pending
  let mut scheduled := scheduled
  for dependency in dependencies do
    unless scheduled.contains dependency do
      pending := dependency :: pending
      scheduled := scheduled.insert dependency
  return (pending, scheduled)

private def collectDeclarationGraph (environment : Environment) (roots : List Name) :
    CoreM DeclarationGraph := do
  let declarationCount := environment.constants.fold (fun count _ _ => count + 1) 0
  let (initialPending, initialScheduled) := scheduleDependencies roots [] {}
  let mut pending := initialPending
  let mut scheduled := initialScheduled
  let mut dependencies : NameMap (List Name) := {}
  let mut declarations : NameMap Json := {}
  let mut remaining := declarationCount + 1
  while !pending.isEmpty do
    if remaining == 0 then
      throwError "normative closure exceeded the imported environment"
    remaining := remaining - 1
    let name := pending.head!
    pending := pending.tail!
    let some info := environment.find? name
      | throwError "reachable declaration {name} is absent from the environment"
    if !isProjectDeclarationName environment name then
      dependencies := dependencies.insert name []
    else
      if hasForbiddenSafety info then
        throwError "reachable declaration {name} is unsafe or partial"
      let expressions := declarationExpressions info
      if expressions.any hasMetavariable then
        throwError "reachable declaration {name} contains an open expression"
      match info with
      | .axiomInfo _ =>
        throwError "reachable project axiom {userDeclarationName name} is forbidden"
      | _ => pure ()
      let encoding ← Meta.MetaM.run' (encodeDeclaration info)
      let declarationDependencies := structuralDependencies info ++ encoding.dependencies
      let next := scheduleDependencies declarationDependencies pending scheduled
      pending := next.1
      scheduled := next.2
      dependencies := dependencies.insert name declarationDependencies
      match encoding.json with
      | none => pure ()
      | some encoded => declarations := declarations.insert name encoded
  pure { dependencies, declarations }

private def collectDesignationClosure (graph : DeclarationGraph) (roots : List Name) :
    Except String (List Name) := do
  let (pending, scheduled) := scheduleDependencies roots [] {}
  let mut pending := pending
  let mut scheduled := scheduled
  let mut names := []
  let mut remaining := graph.dependencies.toArray.size + 1
  while !pending.isEmpty do
    if remaining == 0 then
      throw "designation closure exceeded the declaration graph"
    remaining := remaining - 1
    let name := pending.head!
    pending := pending.tail!
    match graph.dependencies.find? name with
    | none => pure ()
    | some declarationDependencies =>
      let next := scheduleDependencies declarationDependencies pending scheduled
      pending := next.1
      scheduled := next.2
      if graph.declarations.contains name then names := name :: names
  pure names

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
    unless axiomIsAllowed allowed axiomName do
      throwError "designated declaration {designation.name} depends on disallowed axiom {axiomName}"
  let encodedType ← Meta.MetaM.run' (encodeSemanticExpression info.levelParams [] info.type)
  pure {
    designation,
    type := encodedType.json,
    axioms := axioms.toList,
    roots := encodedType.dependencies
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
  auditProjectEnvironment environment allowed
  let mut preparedDesignations := []
  let mut roots := []
  for designation in designations do
    let prepared ← prepareDesignation environment allowed designation
    preparedDesignations := prepared :: preparedDesignations
    roots := prepared.roots ++ roots
  let graph ← collectDeclarationGraph environment roots
  let mut encodedDesignations := []
  for prepared in preparedDesignations.reverse do
    let encoded ← match encodePreparedDesignation graph prepared with
      | .ok value => pure value
      | .error message => throwError message
    encodedDesignations := encoded :: encodedDesignations
  let encodedDeclarations := graph.declarations.toArray.toList.map fun (name, declaration) =>
    Json.mkObj [("name", .str name.toString), ("structure", declaration)]
  let auditedModules := environment.allImportedModuleNames
    |>.filter ((`AgentCore).isPrefixOf ·)
    |>.qsort Name.quickLt
    |>.toList
  pure (Json.mkObj [
    ("encodingVersion", .str encodingVersion),
    ("auditedModules", jsonArray (auditedModules.map (Json.str ·.toString))),
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
