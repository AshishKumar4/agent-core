namespace AgentCore

structure TenantId where value : Nat deriving DecidableEq, Repr
structure PrincipalId where value : Nat deriving DecidableEq, Repr
structure WorkspaceId where value : Nat deriving DecidableEq, Repr
structure AgentId where value : Nat deriving DecidableEq, Repr
structure RunId where value : Nat deriving DecidableEq, Repr
structure TurnId where value : Nat deriving DecidableEq, Repr
structure BranchId where value : Nat deriving DecidableEq, Repr
structure CommitId where value : Nat deriving DecidableEq, Repr
structure SlateId where value : Nat deriving DecidableEq, Repr
structure EnvironmentId where value : Nat deriving DecidableEq, Repr
structure GrantId where value : Nat deriving DecidableEq, Repr
structure BindingId where value : Nat deriving DecidableEq, Repr
structure FacetId where value : Nat deriving DecidableEq, Repr
structure EventId where value : Nat deriving DecidableEq, Repr
structure SubscriptionId where value : Nat deriving DecidableEq, Repr
structure CommittedEventId where value : Nat deriving DecidableEq, Repr

inductive Domain where
  | run (tenant : TenantId) (id : RunId)
  | slate (tenant : TenantId) (id : SlateId)
  deriving DecidableEq, Repr

namespace Domain

def tenant : Domain → TenantId
  | .run tenant _ | .slate tenant _ => tenant

end Domain

inductive Resource where
  | workspace (tenant : TenantId) (id : WorkspaceId)
  | agent (tenant : TenantId) (id : AgentId)
  | environment (tenant : TenantId) (id : EnvironmentId)
  | slate (tenant : TenantId) (id : SlateId)
  | external (tenant : TenantId) (name : String)
  deriving DecidableEq, Repr

namespace Resource

def tenant : Resource → TenantId
  | .workspace tenant _ | .agent tenant _ | .environment tenant _
  | .slate tenant _ | .external tenant _ => tenant

end Resource

inductive Action where
  | read | write | execute | spawn | createSlate | invoke
  deriving DecidableEq, Repr

structure Permission where
  resource : Resource
  action : Action
  deriving DecidableEq, Repr

abbrev Authority := List Permission

def Authority.Subset (child parent : Authority) : Prop :=
  ∀ permission, permission ∈ child → permission ∈ parent

structure Grant where
  target : Domain
  authority : Authority
  parent : Option GrantId
  deriving Repr

structure Binding where
  target : Domain
  name : String
  facet : FacetId
  grant : GrantId
  deriving Repr

structure FacetInstance where
  target : Domain
  workspace : WorkspaceId
  deriving Repr

structure Event where
  tenant : TenantId
  workspace : WorkspaceId
  source : FacetId
  key : Nat
  deriving Repr

structure Subscription where
  tenant : TenantId
  workspace : WorkspaceId
  source : FacetId
  targetWorkspace : WorkspaceId
  target : Domain
  operation : Nat
  enabled : Bool
  deriving Repr

structure CommittedEvent where
  tenant : TenantId
  domain : Domain
  kind : Nat
  deriving Repr

inductive TurnStatus where
  | queued | running | suspended | succeeded | failed | cancelled | interrupted
  deriving DecidableEq, Repr

def CanTransition : TurnStatus → TurnStatus → Prop
  | .queued, .cancelled
  | .running, .suspended | .running, .succeeded | .running, .failed
  | .running, .cancelled | .running, .interrupted
  | .suspended, .cancelled | .suspended, .interrupted => True
  | _, _ => False

inductive TurnOrigin where
  | start
  | spawn (parent : TurnId)
  | retry (parent : TurnId)
  | resume (parent : TurnId)
  deriving DecidableEq, Repr

structure Run where
  tenant : TenantId
  workspace : WorkspaceId
  agent : AgentId
  environment : EnvironmentId
  deriving Repr

structure Branch where
  run : RunId
  parent : Option BranchId
  deriving Repr

structure Commit where
  run : RunId
  branch : BranchId
  parent : Option CommitId
  deriving Repr

structure Turn where
  run : RunId
  branch : BranchId
  origin : TurnOrigin
  status : TurnStatus
  leaseEpoch : Nat
  deriving Repr

structure Tenant where
  members : PrincipalId → Prop
  owners : PrincipalId → Prop

structure Workspace where
  tenant : TenantId
  deriving Repr

structure Agent where
  tenant : TenantId
  workspace : WorkspaceId
  deriving Repr

structure Environment where
  tenant : TenantId
  deriving Repr

inductive InvocationImpact where
  | observe | mutate | externalSend | execute | delegate | administer
  deriving DecidableEq, Repr

structure AuthorizationRequirement where
  binding : BindingId
  permission : Permission
  deriving DecidableEq, Repr

structure ApprovalRequirement where
  operation : Nat
  payload : Nat
  approver : PrincipalId
  deriving DecidableEq, Repr

structure Invocation where
  domain : Domain
  workspace : WorkspaceId
  operation : Nat
  impact : InvocationImpact
  authorization : AuthorizationRequirement
  approval : Option ApprovalRequirement
  deriving Repr

inductive ReceiptOutcome where
  | succeeded | failed | denied | cancelled | indeterminate
  deriving DecidableEq, Repr

structure State where
  tenants : TenantId → Option Tenant
  workspaces : WorkspaceId → Option Workspace
  agents : AgentId → Option Agent
  grants : GrantId → Option Grant
  bindings : BindingId → Option Binding
  facets : FacetId → Option FacetInstance
  events : EventId → Option Event
  subscriptions : SubscriptionId → Option Subscription
  consumedEvents : SubscriptionId → Nat → Prop
  committedEvents : CommittedEventId → Option CommittedEvent
  approvals : Domain → ApprovalRequirement → Prop
  revokedGrants : GrantId → Prop
  runs : RunId → Option Run
  branches : BranchId → Option Branch
  commits : CommitId → Option Commit
  turns : TurnId → Option Turn
  environments : EnvironmentId → Option Environment

instance : Inhabited State where
  default := {
    tenants := fun _ => none
    workspaces := fun _ => none
    agents := fun _ => none
    grants := fun _ => none
    bindings := fun _ => none
    facets := fun _ => none
    events := fun _ => none
    subscriptions := fun _ => none
    consumedEvents := fun _ _ => False
    committedEvents := fun _ => none
    approvals := fun _ _ => False
    revokedGrants := fun _ => False
    runs := fun _ => none
    branches := fun _ => none
    commits := fun _ => none
    turns := fun _ => none
    environments := fun _ => none
  }

def update [DecidableEq α] (table : α → Option β) (key : α) (value : β) : α → Option β :=
  fun candidate => if candidate = key then some value else table candidate

def revoke (revoked : GrantId → Prop) (grant : GrantId) : GrantId → Prop :=
  fun candidate => revoked candidate ∨ candidate = grant

def consumeEvent
    (consumed : SubscriptionId → Nat → Prop)
    (subscription : SubscriptionId)
    (key : Nat) : SubscriptionId → Nat → Prop :=
  fun candidate candidateKey =>
    consumed candidate candidateKey ∨ (candidate = subscription ∧ candidateKey = key)

inductive GrantChain (state : State) : GrantId → GrantId → Prop
  | root {id grant} :
      state.grants id = some grant →
      grant.parent = none →
      GrantChain state id id
  | child {id grant parent parentGrant root} :
      state.grants id = some grant →
      grant.parent = some parent →
      state.grants parent = some parentGrant →
      Authority.Subset grant.authority parentGrant.authority →
      grant.target.tenant = parentGrant.target.tenant →
      GrantChain state parent root →
      GrantChain state id root

inductive LiveGrant (state : State) : GrantId → Prop
  | root {id grant} :
      state.grants id = some grant →
      grant.parent = none →
      ¬state.revokedGrants id →
      LiveGrant state id
  | child {id grant parent} :
      state.grants id = some grant →
      grant.parent = some parent →
      ¬state.revokedGrants id →
      LiveGrant state parent →
      LiveGrant state id

def WellScopedGrant (grant : Grant) : Prop :=
  ∀ permission, permission ∈ grant.authority →
    permission.resource.tenant = grant.target.tenant

def AuthorizedBy
    (state : State)
    (domain : Domain)
    (bindingId : BindingId)
    (permission : Permission) : Prop :=
  ∃ binding grant,
    state.bindings bindingId = some binding ∧
    binding.target = domain ∧
    state.grants binding.grant = some grant ∧
    grant.target = domain ∧
    permission ∈ grant.authority ∧
    WellScopedGrant grant ∧
    LiveGrant state binding.grant ∧
    ∃ root, GrantChain state binding.grant root

inductive Outcome where
  | accepted | denied
  deriving DecidableEq, Repr

namespace Invocation

def AuthorizationSatisfied (state : State) (invocation : Invocation) : Prop :=
  AuthorizedBy state invocation.domain invocation.authorization.binding invocation.authorization.permission

def ApprovalSatisfied (state : State) (invocation : Invocation) : Prop :=
  match invocation.approval with
  | none => True
  | some requirement => state.approvals invocation.domain requirement

def RequirementsSatisfied (state : State) (invocation : Invocation) : Prop :=
  AuthorizationSatisfied state invocation ∧ ApprovalSatisfied state invocation

def Ready (state : State) (invocation : Invocation) : Prop :=
  match invocation.domain with
  | .run tenant runId =>
      ∃ run turnId turn,
        state.runs runId = some run ∧
        run.tenant = tenant ∧
        run.workspace = invocation.workspace ∧
        state.turns turnId = some turn ∧
        turn.run = runId ∧
        turn.status = .running
  | .slate _ _ => True

end Invocation

structure Receipt where
  invocation : Invocation
  outcome : ReceiptOutcome
  deriving Repr

inductive InvocationRecordKind where
  | audit | event | telemetry
  deriving DecidableEq, Repr

inductive Label where
  | createTenant (id : TenantId)
  | createWorkspace (id : WorkspaceId)
  | createAgent (id : AgentId)
  | installFacet (id : FacetId)
  | createEnvironment (environment : EnvironmentId)
  | issueRootGrant (id : GrantId)
  | delegate (parent child : GrantId)
  | bind (id : BindingId)
  | acceptEvent (id : EventId)
  | createSubscription (id : SubscriptionId)
  | fireSubscription (subscription : SubscriptionId) (event : EventId) (receipt : Receipt)
  | emitCommittedEvent (id : CommittedEventId)
  | revoke (id : GrantId)
  | startRun (id : RunId)
  | createBranch (id : BranchId)
  | commitBranch (id : CommitId)
  | startTurn (id : TurnId)
  | spawnTurn (parent child : TurnId)
  | retryTurn (parent retry : TurnId)
  | resumeTurn (parent resumed : TurnId)
  | claimTurn (id : TurnId)
  | transitionTurn (id : TurnId) (status : TurnStatus)
  | rotateEnvironment (id : EnvironmentId)
  | invocation (kind : InvocationRecordKind) (receipt : Receipt)
  | deniedInvocation (invocation : Invocation)
  deriving Repr

inductive Step : State → Label → Outcome → State → Prop
  | createTenant {state id tenant} :
      state.tenants id = none →
      (∀ principal, tenant.owners principal → tenant.members principal) →
      Step state (.createTenant id) .accepted
        { state with tenants := update state.tenants id tenant }
  | createWorkspace {state id workspace principal tenant} :
      state.workspaces id = none →
      state.tenants workspace.tenant = some tenant →
      tenant.owners principal →
      Step state (.createWorkspace id) .accepted
        { state with workspaces := update state.workspaces id workspace }
  | createAgent {state id agent workspace tenant principal} :
      state.agents id = none →
      state.workspaces agent.workspace = some workspace →
      workspace.tenant = agent.tenant →
      state.tenants agent.tenant = some tenant →
      tenant.owners principal →
      Step state (.createAgent id) .accepted
        { state with agents := update state.agents id agent }
  | installFacet {state id facet workspace} :
      state.facets id = none →
      state.workspaces facet.workspace = some workspace →
      workspace.tenant = facet.target.tenant →
      Step state (.installFacet id) .accepted
        { state with facets := update state.facets id facet }
  | createEnvironment {state environmentId environment tenant principal} :
      state.environments environmentId = none →
      state.tenants environment.tenant = some tenant →
      tenant.owners principal →
      Step state (.createEnvironment environmentId) .accepted
        { state with environments := update state.environments environmentId environment }
  | issueRootGrant {state id grant principal tenant} :
      state.grants id = none →
      state.tenants grant.target.tenant = some tenant →
      tenant.owners principal →
      grant.parent = none →
      WellScopedGrant grant →
      Step state (.issueRootGrant id) .accepted
        { state with grants := update state.grants id grant }
  | delegate {state parent child parentGrant childGrant} :
      state.grants parent = some parentGrant →
      LiveGrant state parent →
      childGrant.parent = some parent →
      childGrant.target.tenant = parentGrant.target.tenant →
      Authority.Subset childGrant.authority parentGrant.authority →
      WellScopedGrant childGrant →
      state.grants child = none →
      Step state (.delegate parent child) .accepted
        { state with grants := update state.grants child childGrant }
  | bind {state id binding grant facet} :
      state.bindings id = none →
      state.grants binding.grant = some grant →
      state.facets binding.facet = some facet →
      binding.target = grant.target →
      facet.target = binding.target →
      LiveGrant state binding.grant →
      Step state (.bind id) .accepted
        { state with bindings := update state.bindings id binding }
  | acceptEvent {state id event workspace facet} :
      state.events id = none →
      state.workspaces event.workspace = some workspace →
      workspace.tenant = event.tenant →
      state.facets event.source = some facet →
      facet.target.tenant = event.tenant →
      facet.workspace = event.workspace →
      Step state (.acceptEvent id) .accepted
        { state with events := update state.events id event }
  | createSubscription {state id subscription workspace facet} :
      state.subscriptions id = none →
      state.workspaces subscription.workspace = some workspace →
      workspace.tenant = subscription.tenant →
      state.facets subscription.source = some facet →
      facet.target.tenant = subscription.tenant →
      facet.workspace = subscription.workspace →
      subscription.target.tenant = subscription.tenant →
      subscription.targetWorkspace = subscription.workspace →
      Step state (.createSubscription id) .accepted
        { state with subscriptions := update state.subscriptions id subscription }
  | fireSubscription {state subscriptionId eventId subscription event receipt} :
      state.subscriptions subscriptionId = some subscription →
      state.events eventId = some event →
      subscription.enabled = true →
      subscription.tenant = event.tenant →
      subscription.workspace = event.workspace →
      subscription.source = event.source →
      receipt.invocation.domain = subscription.target →
      receipt.invocation.workspace = subscription.targetWorkspace →
      receipt.invocation.operation = subscription.operation →
      ¬state.consumedEvents subscriptionId event.key →
      receipt.outcome = .succeeded →
      Invocation.RequirementsSatisfied state receipt.invocation →
      Invocation.Ready state receipt.invocation →
      Step state (.fireSubscription subscriptionId eventId receipt) .accepted
        { state with consumedEvents := consumeEvent state.consumedEvents subscriptionId event.key }
  | emitCommittedEvent {state id event} :
      state.committedEvents id = none →
      event.domain.tenant = event.tenant →
      Step state (.emitCommittedEvent id) .accepted
        { state with committedEvents := update state.committedEvents id event }
  | revoke {state id} :
      Step state (.revoke id) .accepted
        { state with revokedGrants := revoke state.revokedGrants id }
  | startRun {state id run agent workspace environment} :
      state.runs id = none →
      state.agents run.agent = some agent →
      agent.tenant = run.tenant →
      agent.workspace = run.workspace →
      state.workspaces run.workspace = some workspace →
      workspace.tenant = run.tenant →
      state.environments run.environment = some environment →
      environment.tenant = run.tenant →
      Step state (.startRun id) .accepted
        { state with runs := update state.runs id run }
  | createBranch {state id branch run parent parentBranch} :
      state.branches id = none →
      state.runs branch.run = some run →
      (branch.parent = none ∨
        (branch.parent = some parent ∧
          state.branches parent = some parentBranch ∧
          parentBranch.run = branch.run)) →
      Step state (.createBranch id) .accepted
        { state with branches := update state.branches id branch }
  | commitBranch {state id commit branch parent parentCommit} :
      state.commits id = none →
      state.branches commit.branch = some branch →
      branch.run = commit.run →
      (commit.parent = none ∨
        (commit.parent = some parent ∧
          state.commits parent = some parentCommit ∧
          parentCommit.run = commit.run)) →
      Step state (.commitBranch id) .accepted
        { state with commits := update state.commits id commit }
  | startTurn {state id turn run branch} :
      state.turns id = none →
      state.runs turn.run = some run →
      state.branches turn.branch = some branch →
      branch.run = turn.run →
      turn.origin = .start →
      turn.status = .queued →
      turn.leaseEpoch = 0 →
      Step state (.startTurn id) .accepted
        { state with turns := update state.turns id turn }
  | spawnTurn {state parentId childId parent child} :
      state.turns parentId = some parent →
      parent.status = .running →
      state.turns childId = none →
      child.origin = .spawn parentId →
      child.run = parent.run →
      child.branch = parent.branch →
      child.status = .queued →
      child.leaseEpoch = 0 →
      Step state (.spawnTurn parentId childId) .accepted
        { state with turns := update state.turns childId child }
  | retryTurn {state parentId retryId parent retry} :
      state.turns parentId = some parent →
      (parent.status = .failed ∨ parent.status = .interrupted) →
      state.turns retryId = none →
      retry.origin = .retry parentId →
      retry.run = parent.run →
      retry.branch = parent.branch →
      retry.status = .queued →
      retry.leaseEpoch = 0 →
      Step state (.retryTurn parentId retryId) .accepted
        { state with turns := update state.turns retryId retry }
  | resumeTurn {state parentId resumedId parent resumed} :
      state.turns parentId = some parent →
      parent.status = .suspended →
      state.turns resumedId = none →
      resumed.origin = .resume parentId →
      resumed.run = parent.run →
      resumed.branch = parent.branch →
      resumed.leaseEpoch > parent.leaseEpoch →
      resumed.status = .queued →
      Step state (.resumeTurn parentId resumedId) .accepted
        { state with turns := update state.turns resumedId resumed }
  | claimTurn {state id turn epoch} :
      state.turns id = some turn →
      (turn.status = .queued ∨ turn.status = .suspended) →
      epoch > turn.leaseEpoch →
      Step state (.claimTurn id) .accepted
        { state with turns := update state.turns id { turn with status := .running, leaseEpoch := epoch } }
  | transitionTurn {state id turn next} :
      state.turns id = some turn →
      CanTransition turn.status next →
      Step state (.transitionTurn id next) .accepted
        { state with turns := update state.turns id { turn with status := next } }
  | rotateEnvironment {state id environment} :
      state.environments id = some environment →
      Step state (.rotateEnvironment id) .accepted state
  | invocation {state kind receipt} :
      receipt.outcome = .succeeded →
      Invocation.RequirementsSatisfied state receipt.invocation →
      Invocation.Ready state receipt.invocation →
      Step state (.invocation kind receipt) .accepted state
  | deniedInvocation {state invocation} :
      ¬Invocation.RequirementsSatisfied state invocation →
      Step state (.deniedInvocation invocation) .denied state

inductive Exec : State → List Label → State → Prop
  | nil (state) : Exec state [] state
  | cons {start middle finish label labels outcome} :
      Step start label outcome middle →
      Exec middle labels finish →
      Exec start (label :: labels) finish

structure WellFormed (state : State) : Prop where
  ownersAreMembers :
    ∀ id tenant, state.tenants id = some tenant →
      ∀ principal, tenant.owners principal → tenant.members principal
  workspacesHaveTenants :
    ∀ id workspace, state.workspaces id = some workspace →
      ∃ tenant, state.tenants workspace.tenant = some tenant
  grantsHaveTenants :
    ∀ id grant, state.grants id = some grant →
      ∃ tenant, state.tenants grant.target.tenant = some tenant
  grantsAreScoped :
    ∀ id grant, state.grants id = some grant → WellScopedGrant grant
  grantsHaveChains :
    ∀ id grant, state.grants id = some grant →
      ∃ root, GrantChain state id root
  bindingsMatchGrants :
    ∀ id binding, state.bindings id = some binding →
      ∃ grant facet,
        state.grants binding.grant = some grant ∧
        state.facets binding.facet = some facet ∧
        binding.target = grant.target ∧
        facet.target = binding.target
  environmentsAreValid :
    ∀ id environment, state.environments id = some environment →
      ∃ tenant, state.tenants environment.tenant = some tenant
  runsArePinned :
    ∀ id run, state.runs id = some run →
      ∃ environment,
        state.environments run.environment = some environment ∧
        environment.tenant = run.tenant
  agentsHaveWorkspaces :
    ∀ id agent, state.agents id = some agent →
      ∃ workspace tenant,
        state.workspaces agent.workspace = some workspace ∧
        workspace.tenant = agent.tenant ∧
        state.tenants agent.tenant = some tenant
  runsHaveAgents :
    ∀ id run, state.runs id = some run →
      ∃ agent,
        state.agents run.agent = some agent ∧
        agent.tenant = run.tenant ∧
        agent.workspace = run.workspace

def Initial (state : State) : Prop := state = default

inductive Reachable : State → Prop
  | initial {state} : Initial state → Reachable state
  | step {before after label outcome} :
      Reachable before → Step before label outcome after → Reachable after

structure MoALayer where
  branch : BranchId
  commit : CommitId
  turn : TurnId
  invocation : Invocation
  deriving Repr

structure LayeredMoA where
  run : RunId
  coordinator : MoALayer
  workers : List MoALayer
  synthesis : MoALayer
  deriving Repr

def LayerRepresented (state : State) (runId : RunId) (run : Run) (layer : MoALayer) : Prop :=
  ∃ branch commit turn,
    state.branches layer.branch = some branch ∧
    branch.run = runId ∧
    state.commits layer.commit = some commit ∧
    commit.run = runId ∧
    commit.branch = layer.branch ∧
    state.turns layer.turn = some turn ∧
    turn.run = runId ∧
    turn.branch = layer.branch ∧
    layer.invocation.domain = .run run.tenant runId ∧
    layer.invocation.workspace = run.workspace

def LayeredMoARepresented (state : State) (shape : LayeredMoA) : Prop :=
  ∃ run,
    state.runs shape.run = some run ∧
    LayerRepresented state shape.run run shape.coordinator ∧
    (∀ layer, layer ∈ shape.workers → LayerRepresented state shape.run run layer) ∧
    LayerRepresented state shape.run run shape.synthesis

theorem hermes_mixture_of_agents_representable {state : State} {runId : RunId} {run : Run}
    {coordinator synthesis : MoALayer} {workers : List MoALayer}
    (runLookup : state.runs runId = some run)
    (coordinatorRepresented : LayerRepresented state runId run coordinator)
    (workersRepresented : ∀ layer, layer ∈ workers → LayerRepresented state runId run layer)
    (synthesisRepresented : LayerRepresented state runId run synthesis) :
    LayeredMoARepresented state {
      run := runId,
      coordinator,
      workers,
      synthesis
    } := by
  exact ⟨run, runLookup, coordinatorRepresented, workersRepresented, synthesisRepresented⟩

end AgentCore
