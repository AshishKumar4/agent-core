/-!
# Shared immutable vocabulary

All cross-component identity evidence lives here to avoid circular ownership. A prepared
Invocation has one stable id and one header covering placement, authority, optional exact
Turn lease incarnation, path evidence, route evidence, audit cause, idempotency seed,
and the whole ordered payload. Item keys are structural derivations, not hash claims.
-/

namespace AgentCore

structure TenantId where value : Nat deriving DecidableEq, Repr
structure ProjectId where value : Nat deriving DecidableEq, Repr
structure WorkspaceId where value : Nat deriving DecidableEq, Repr
structure PrincipalId where value : Nat deriving DecidableEq, Repr
structure PrincipalRef where
  tenant : TenantId
  id : PrincipalId
  deriving DecidableEq, Repr

theorem principal_ref_tenant_is_identity {left right : PrincipalRef}
    (differentTenant : left.tenant ≠ right.tenant) : left ≠ right := by
  intro equal
  apply differentTenant
  rw [equal]
structure TeamId where value : Nat deriving DecidableEq, Repr
structure MembershipId where value : Nat deriving DecidableEq, Repr
structure RoleId where value : Nat deriving DecidableEq, Repr
structure FacetId where value : Nat deriving DecidableEq, Repr
structure BindingId where value : Nat deriving DecidableEq, Repr
structure ResolutionId where value : Nat deriving DecidableEq, Repr
structure AgentId where value : Nat deriving DecidableEq, Repr
structure RunId where value : Nat deriving DecidableEq, Repr
structure TurnId where value : Nat deriving DecidableEq, Repr
structure BranchId where value : Nat deriving DecidableEq, Repr
structure CommitId where value : Nat deriving DecidableEq, Repr
structure InvocationId where value : Nat deriving DecidableEq, Repr
structure ApprovalId where value : Nat deriving DecidableEq, Repr
structure AttemptId where value : Nat deriving DecidableEq, Repr
structure ItemClaimId where value : Nat deriving DecidableEq, Repr
structure ClaimWorkerId where value : Nat deriving DecidableEq, Repr
structure ReceiptId where value : Nat deriving DecidableEq, Repr
structure EventId where value : Nat deriving DecidableEq, Repr
structure ReservationId where value : Nat deriving DecidableEq, Repr
structure ProjectionId where value : Nat deriving DecidableEq, Repr
structure AuditId where value : Nat deriving DecidableEq, Repr
structure BlueprintId where value : Nat deriving DecidableEq, Repr
structure PackageId where value : Nat deriving DecidableEq, Repr
structure TreeId where value : Nat deriving DecidableEq, Repr

inductive GrantId where
  | manual (value : Nat)
  | role (membership : MembershipId) (ruleIndex : Nat)
  deriving DecidableEq, Repr

structure Time where tick : Nat deriving DecidableEq, Repr

inductive Scope where
  | tenant (tenant : TenantId)
  | project (tenant : TenantId) (project : ProjectId)
  | workspace (tenant : TenantId) (project : Option ProjectId) (workspace : WorkspaceId)
  deriving DecidableEq, Repr

inductive ProtectionDomain where
  | run (tenant : TenantId) (run : RunId)
  | workspace (tenant : TenantId) (workspace : WorkspaceId)
  deriving DecidableEq, Repr

def ProtectionDomain.tenant : ProtectionDomain → TenantId
  | .run tenant _ | .workspace tenant _ => tenant

inductive Subject where
  | principal (id : PrincipalId)
  | team (id : TeamId)
  | foreign (homeTenant : TenantId) (id : PrincipalId)
  deriving DecidableEq, Repr

inductive Resource where
  | workspace (tenant : TenantId) (id : WorkspaceId)
  | agent (tenant : TenantId) (id : AgentId)
  | run (tenant : TenantId) (id : RunId)
  | external (tenant : TenantId) (name : String)
  deriving DecidableEq, Repr

def Resource.tenant : Resource → TenantId
  | .workspace tenant _ | .agent tenant _ | .run tenant _ | .external tenant _ => tenant

inductive Action where | observe | mutate | execute | externalSend | delegate | administer
  deriving DecidableEq, Repr

structure Permission where
  resource : Resource
  action : Action
  deriving DecidableEq, Repr

inductive GrantEffect where | allow | deny deriving DecidableEq, Repr
inductive GrantSource where
  | manual
  | roleRule (membership : MembershipId) (role : RoleId) (ruleIndex : Nat)
  deriving DecidableEq, Repr

structure Grant where
  subject : Subject
  scope : Scope
  effect : GrantEffect
  permission : Permission
  parent : Option GrantId
  source : GrantSource
  deriving DecidableEq, Repr

structure Binding where
  domain : ProtectionDomain
  scope : Scope
  name : String
  grant : GrantId
  facet : FacetId
  deriving DecidableEq, Repr

structure RoleRule where
  effect : GrantEffect
  permission : Permission
  deriving DecidableEq, Repr
structure Role where
  id : RoleId
  rules : List RoleRule
  deriving DecidableEq, Repr
structure Membership where
  id : MembershipId
  subject : Subject
  scope : Scope
  role : RoleId
  deriving DecidableEq, Repr

inductive InvocationImpact where | observe | mutate | externalSend | execute | delegate | administer
  deriving DecidableEq, Repr

structure OperationId where
  facet : FacetId
  name : String
  version : Nat
  deriving DecidableEq, Repr

inductive ActorRef where
  | tenant (tenant : TenantId)
  | workspace (tenant : TenantId) (workspace : WorkspaceId)
  | run (tenant : TenantId) (run : RunId)
  | external (tenant : TenantId) (name : String)
  deriving DecidableEq, Repr

def actorTenantOf : ActorRef → TenantId
  | .tenant tenant => tenant
  | .workspace tenant _ => tenant
  | .run tenant _ => tenant
  | .external tenant _ => tenant

def domainOwner : ProtectionDomain → ActorRef
  | .run tenant run => .run tenant run
  | .workspace tenant workspace => .workspace tenant workspace

structure CallerEvidence where
  actor : ActorRef
  authenticated : Bool
  deriving DecidableEq, Repr

inductive Placement where | bundled | provider | dynamic deriving DecidableEq, Repr

structure PlacementSet where
  bundled : Bool
  provider : Bool
  dynamic : Bool
  deriving DecidableEq, Repr

structure PlacementSnapshot where
  manifest : PlacementSet
  policy : PlacementSet
  substrate : PlacementSet
  trust : PlacementSet
  selected : Placement
  deriving DecidableEq, Repr

inductive AuthoritySource where
  | initiator (principal : PrincipalRef) (binding : BindingId)
  | delegated (principal : PrincipalRef) (binding : BindingId)
  deriving DecidableEq, Repr

def AuthoritySource.binding : AuthoritySource → BindingId
  | .initiator _ binding | .delegated _ binding => binding

def AuthoritySource.principal : AuthoritySource → PrincipalRef
  | .initiator principal _ | .delegated principal _ => principal

structure LeaseToken where
  turn : TurnId
  holder : PrincipalRef
  epoch : Nat
  deriving DecidableEq, Repr

structure PathEpoch where
  scope : Scope
  epoch : Nat
  deriving DecidableEq, Repr

structure RouteEvidence where
  reservation : Option ReservationId
  projection : Option ProjectionId
  deriving DecidableEq, Repr

structure StructuralValue where
  format : String
  tokens : List String
  deriving DecidableEq, Repr

structure InvocationHeader where
  invocation : InvocationId
  operation : OperationId
  impact : InvocationImpact
  domain : ProtectionDomain
  target : Resource
  authority : AuthoritySource
  caller : CallerEvidence
  lease : Option LeaseToken
  placement : PlacementSnapshot
  pathEvidence : List PathEpoch
  routeEvidence : RouteEvidence
  projectionDigest : Option StructuralValue
  auditCause : AuditId
  idempotencySeed : String
  deriving DecidableEq, Repr

def InvocationHeader.binding (header : InvocationHeader) : BindingId := header.authority.binding

def InvocationHeader.RouteEvidenceConsistent (header : InvocationHeader) : Prop :=
  match header.routeEvidence.reservation, header.routeEvidence.projection,
      header.projectionDigest with
  | none, none, none => True
  | some _, some _, some _ => True
  | _, _, _ => False

def InvocationHeader.permission (header : InvocationHeader) : Permission :=
  ⟨header.target, match header.impact with
    | .observe => .observe | .mutate => .mutate | .execute => .execute
    | .externalSend => .externalSend | .delegate => .delegate | .administer => .administer⟩

inductive InvocationPayload where
  | single (arguments : StructuralValue)
  | batch (head : StructuralValue) (tail : List StructuralValue)
  deriving DecidableEq, Repr

def InvocationPayload.arguments : InvocationPayload → List StructuralValue
  | .single arguments => [arguments]
  | .batch head tail => head :: tail

theorem InvocationPayload.arguments_nonempty (payload : InvocationPayload) :
    payload.arguments ≠ [] := by cases payload <;> simp [InvocationPayload.arguments]

inductive PayloadShape where
  | single
  | batch (length : Nat)
  deriving DecidableEq, Repr

def InvocationPayload.shape : InvocationPayload → PayloadShape
  | .single _ => .single
  | .batch _ tail => .batch (tail.length + 1)

/- The formal digest is deliberately collision-free structural identity, not a claim
about any concrete hash implementation. -/
abbrev StructuralDigest := StructuralValue

def structuralDigest (value : StructuralValue) : StructuralDigest := value

theorem structuralDigest_exact {left right : StructuralValue} :
    structuralDigest left = structuralDigest right ↔ left = right := Iff.rfl

structure ItemKey where
  invocation : InvocationId
  header : InvocationHeader
  payloadShape : PayloadShape
  index : Nat
  arguments : StructuralValue
  digest : StructuralDigest
  seed : String
  deriving DecidableEq, Repr

def deriveItemKey (header : InvocationHeader) (payload : InvocationPayload)
    (index : Nat) (arguments : StructuralValue) : ItemKey :=
  ⟨header.invocation, header, payload.shape, index, arguments, structuralDigest arguments,
    header.idempotencySeed⟩

structure PreparedItem where
  index : Nat
  arguments : StructuralValue
  key : ItemKey
  deriving DecidableEq, Repr

def prepareItemsFrom (header : InvocationHeader) (payload : InvocationPayload) :
    Nat → List StructuralValue → List PreparedItem
  | _, [] => []
  | index, arguments :: rest =>
      ⟨index, arguments, deriveItemKey header payload index arguments⟩ ::
        prepareItemsFrom header payload (index + 1) rest

def prepareItems (header : InvocationHeader) (payload : InvocationPayload) : List PreparedItem :=
  prepareItemsFrom header payload 0 payload.arguments

structure PreparedInvocation where
  header : InvocationHeader
  payload : InvocationPayload
  deriving DecidableEq, Repr

def PreparedInvocation.items (prepared : PreparedInvocation) : List PreparedItem :=
  prepareItems prepared.header prepared.payload

structure InvocationIdentity where
  header : InvocationHeader
  payload : InvocationPayload
  items : List PreparedItem
  deriving DecidableEq, Repr

abbrev InvocationDigest := InvocationIdentity

def PreparedInvocation.identity (prepared : PreparedInvocation) : InvocationIdentity :=
  ⟨prepared.header, prepared.payload, prepared.items⟩

def PreparedInvocation.digest (prepared : PreparedInvocation) : InvocationDigest := prepared.identity

theorem invocationDigest_exact {left right : PreparedInvocation} :
    left.digest = right.digest ↔ left = right := by
  constructor
  · intro equal
    cases left with
    | mk leftHeader leftPayload =>
      cases right with
      | mk rightHeader rightPayload =>
        change InvocationIdentity.mk leftHeader leftPayload _ =
          InvocationIdentity.mk rightHeader rightPayload _ at equal
        injection equal with headerEq payloadEq
        subst rightHeader
        subst rightPayload
        rfl
  · intro equal
    cases equal
    rfl

private theorem prepareItemsFrom_key {header payload index values item}
    (member : item ∈ prepareItemsFrom header payload index values) :
    item.key = deriveItemKey header payload item.index item.arguments := by
  induction values generalizing index with
  | nil => simp [prepareItemsFrom] at member
  | cons value rest ih =>
      simp only [prepareItemsFrom, List.mem_cons] at member
      rcases member with rfl | member
      · rfl
      · exact ih member

theorem prepared_item_key_is_derived {prepared : PreparedInvocation} {item : PreparedItem}
    (member : item ∈ prepared.items) :
    item.key = deriveItemKey prepared.header prepared.payload item.index item.arguments := by
  unfold PreparedInvocation.items prepareItems at member
  exact prepareItemsFrom_key member

theorem prepared_item_key_commits_complete_structure {prepared : PreparedInvocation}
    {item : PreparedItem} (member : item ∈ prepared.items) :
    item.key.invocation = prepared.header.invocation ∧
    item.key.header = prepared.header ∧
    item.key.payloadShape = prepared.payload.shape ∧
    item.key.index = item.index ∧ item.key.arguments = item.arguments ∧
    item.key.digest = structuralDigest item.arguments ∧
    item.key.seed = prepared.header.idempotencySeed := by
  rw [prepared_item_key_is_derived member]
  exact ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩

structure InterceptorTransformation where
  interceptor : Nat
  input : StructuralValue
  output : StructuralValue
  deriving DecidableEq, Repr

def TransformationChain : StructuralValue → StructuralValue →
    List InterceptorTransformation → Prop
  | input, output, [] => input = output
  | input, output, transformation :: rest =>
      transformation.input = input ∧ TransformationChain transformation.output output rest

structure ReplayItem where
  index : Nat
  key : ItemKey
  before : List InterceptorTransformation
  preparedArguments : StructuralValue
  effectOutput : StructuralValue
  after : List InterceptorTransformation
  presentation : StructuralValue
  deriving DecidableEq, Repr

def ReplayItem.ValidFor (replay : ReplayItem) (item : PreparedItem) : Prop :=
  replay.index = item.index ∧ replay.key = item.key ∧
    TransformationChain item.arguments replay.preparedArguments replay.before ∧
    TransformationChain replay.effectOutput replay.presentation replay.after

def ReplayItemsMatch : List PreparedItem → List ReplayItem → Prop
  | [], [] => True
  | item :: items, replay :: replays => replay.ValidFor item ∧ ReplayItemsMatch items replays
  | _, _ => False

structure MediatedReplay where
  invocation : InvocationId
  items : List ReplayItem
  deriving DecidableEq, Repr

def MediatedReplay.ValidFor (replay : MediatedReplay) (prepared : PreparedInvocation) : Prop :=
  replay.invocation = prepared.header.invocation ∧ ReplayItemsMatch prepared.items replay.items

private theorem replayItemsMatch_preserves_order_and_keys {items : List PreparedItem}
    {replays : List ReplayItem} (evidence : ReplayItemsMatch items replays) :
    replays.map ReplayItem.index = items.map PreparedItem.index ∧
    replays.map ReplayItem.key = items.map PreparedItem.key := by
  induction items generalizing replays with
  | nil => cases replays <;> simp_all [ReplayItemsMatch]
  | cons item rest ih =>
      cases replays with
      | nil => simp [ReplayItemsMatch] at evidence
      | cons replayItem replayRest =>
          simp only [ReplayItemsMatch] at evidence
          obtain ⟨valid, tail⟩ := evidence
          obtain ⟨index, key, before, after⟩ := valid
          simp [index, key, ih tail]

theorem replay_preserves_item_order_and_keys {replay : MediatedReplay}
    {prepared : PreparedInvocation} (valid : replay.ValidFor prepared) :
    replay.items.map ReplayItem.index = prepared.items.map PreparedItem.index ∧
    replay.items.map ReplayItem.key = prepared.items.map PreparedItem.key :=
  replayItemsMatch_preserves_order_and_keys valid.2

inductive EnforcementTier where | direct | mediated deriving DecidableEq, Repr
inductive ReceiptOutcome where | succeeded | failed | denied | cancelled | indeterminate
  deriving DecidableEq, Repr
def ReceiptOutcome.Final : ReceiptOutcome → Prop | .indeterminate => False | _ => True

def tableSet [DecidableEq α] (table : α → Option β) (key : α) (value : β) : α → Option β :=
  fun candidate => if candidate = key then some value else table candidate

@[simp] theorem tableSet_self [DecidableEq α] (table : α → Option β) (key : α) (value : β) :
    tableSet table key value key = some value := by simp [tableSet]

theorem tableSet_other [DecidableEq α] (table : α → Option β) (key other : α)
    (different : other ≠ key) (value : β) : tableSet table key value other = table other := by
  simp [tableSet, different]

def mark [DecidableEq α] (set : α → Prop) (key : α) : α → Prop :=
  fun candidate => set candidate ∨ candidate = key

end AgentCore
