import AgentCore.Proofs.Reachability

namespace AgentCore.Examples

private def tenant : TenantId := ⟨1⟩
private def principal : PrincipalId := ⟨1⟩
private def workspace : WorkspaceId := ⟨1⟩
private def agent : AgentId := ⟨1⟩
private def runId : RunId := ⟨1⟩
private def branchId : BranchId := ⟨1⟩
private def turnId : TurnId := ⟨1⟩
private def environment : EnvironmentId := ⟨1⟩
private def rootGrantId : GrantId := ⟨1⟩
private def bindingId : BindingId := ⟨1⟩
private def missingBindingId : BindingId := ⟨99⟩
private def facetId : FacetId := ⟨1⟩

private def domain : Domain := .run tenant runId
private def permission : Permission := {
  resource := .environment tenant environment
  action := .execute
}

private def authorizationRequirement : AuthorizationRequirement := {
  binding := bindingId
  permission
}

private def missingAuthorizationRequirement : AuthorizationRequirement := {
  binding := missingBindingId
  permission
}

private def invocation : Invocation := {
  domain
  workspace
  operation := 1
  impact := .execute
  authorization := authorizationRequirement
  approval := none
}

private def missingInvocation : Invocation := {
  domain
  workspace
  operation := 1
  impact := .execute
  authorization := missingAuthorizationRequirement
  approval := none
}

private def acceptedReceipt : Receipt := {
  invocation
  outcome := .succeeded
}

private def traceTenant : Tenant := {
  members := fun candidate => candidate = principal
  owners := fun candidate => candidate = principal
}

private def traceWorkspace : Workspace := { tenant }
private def traceAgent : Agent := { tenant, workspace }
private def traceEnvironment : Environment := { tenant }
private def traceFacet : FacetInstance := { target := domain, workspace }

private def rootGrant : Grant := {
  target := domain
  authority := [permission]
  parent := none
}

private def rootBinding : Binding := {
  target := domain
  name := "sandbox"
  facet := facetId
  grant := rootGrantId
}

private def sessionRun : Run := {
  tenant
  workspace
  agent
  environment
}

private def rootBranch : Branch := {
  run := runId
  parent := none
}

private def queuedTurn : Turn := {
  run := runId
  branch := branchId
  origin := .start
  status := .queued
  leaseEpoch := 0
}

private def runningTurn : Turn := {
  queuedTurn with status := .running, leaseEpoch := 1
}

private def tenantState : State := {
  (default : State) with tenants := update (default : State).tenants tenant traceTenant
}

private def workspaceState : State := {
  tenantState with workspaces := update tenantState.workspaces workspace traceWorkspace
}

private def agentState : State := {
  workspaceState with agents := update workspaceState.agents agent traceAgent
}

private def environmentState : State := {
  agentState with environments := update agentState.environments environment traceEnvironment
}

private def facetState : State := {
  environmentState with facets := update environmentState.facets facetId traceFacet
}

private def grantState : State := {
  facetState with grants := update facetState.grants rootGrantId rootGrant
}

private def bindingState : State := {
  grantState with bindings := update grantState.bindings bindingId rootBinding
}

private def runState : State := {
  bindingState with runs := update bindingState.runs runId sessionRun
}

private def branchState : State := {
  runState with branches := update runState.branches branchId rootBranch
}

private def queuedTurnState : State := {
  branchState with turns := update branchState.turns turnId queuedTurn
}

private def runningState : State := {
  queuedTurnState with turns := update queuedTurnState.turns turnId runningTurn
}

private def revokedState : State := {
  runningState with revokedGrants := revoke runningState.revokedGrants rootGrantId
}

private theorem rootScoped : WellScopedGrant rootGrant := by
  intro requested member
  simp [rootGrant] at member
  subst requested
  rfl

private theorem rootLiveAtGrantState : LiveGrant grantState rootGrantId := by
  apply LiveGrant.root (grant := rootGrant)
  · simp [grantState, facetState, environmentState, agentState, workspaceState, tenantState, rootGrantId]
  · rfl
  · intro revoked
    contradiction

private theorem rootLiveAtRunningState : LiveGrant runningState rootGrantId := by
  apply LiveGrant.root (grant := rootGrant)
  · simp [runningState, queuedTurnState, branchState, runState, bindingState, grantState,
      facetState, environmentState, agentState, workspaceState, tenantState, rootGrantId]
  · rfl
  · intro revoked
    contradiction

private theorem rootChainAtRunningState : GrantChain runningState rootGrantId rootGrantId := by
  apply GrantChain.root (grant := rootGrant)
  · simp [runningState, queuedTurnState, branchState, runState, bindingState, grantState,
      facetState, environmentState, agentState, workspaceState, tenantState, rootGrantId]
  · rfl

private theorem traceAuthorized : AuthorizedBy runningState domain bindingId permission := by
  exact ⟨rootBinding, rootGrant,
    by simp [runningState, queuedTurnState, branchState, runState, bindingState, grantState,
      facetState, environmentState, agentState, workspaceState, tenantState, bindingId],
    rfl,
    by simp [runningState, queuedTurnState, branchState, runState, bindingState, grantState,
      facetState, environmentState, agentState, workspaceState, tenantState, rootBinding, rootGrantId],
    rfl, by simp [rootGrant, permission], rootScoped, rootLiveAtRunningState,
    ⟨rootGrantId, rootChainAtRunningState⟩⟩

theorem nonvacuous_authorized_invocation :
    Step runningState (.invocation .audit acceptedReceipt) .accepted runningState := by
  apply Step.invocation
  · rfl
  · constructor
    · change AuthorizedBy runningState domain bindingId permission
      exact traceAuthorized
    · trivial
  · exact ⟨sessionRun, turnId, runningTurn,
      by simp [runningState, queuedTurnState, branchState, runState, bindingState, grantState,
        facetState, environmentState, agentState, workspaceState, tenantState, runId],
      rfl,
      rfl,
      by simp [runningState, queuedTurnState, branchState, runState, bindingState, grantState,
        facetState, environmentState, agentState, workspaceState, tenantState, turnId],
      rfl,
      rfl⟩

theorem nonvacuous_denied_invocation :
    Step runningState (.deniedInvocation missingInvocation) .denied runningState := by
  apply Step.deniedInvocation
  intro supposed
  obtain ⟨binding, grant, lookup, _rest⟩ := supposed.left
  simp [Invocation.AuthorizationSatisfied, runningState, queuedTurnState, branchState, runState,
    bindingState, grantState, facetState, environmentState, agentState, workspaceState,
    tenantState, missingInvocation, missingAuthorizationRequirement, missingBindingId, bindingId,
    update] at lookup

private def childGrantId : GrantId := ⟨2⟩

private def childGrant : Grant := {
  target := domain
  authority := [permission]
  parent := some rootGrantId
}

private theorem childScoped : WellScopedGrant childGrant := by
  intro requested member
  simp [childGrant] at member
  subst requested
  rfl

theorem nonvacuous_attenuated_delegation :
    ∃ after, Step grantState (.delegate rootGrantId childGrantId) .accepted after := by
  let after : State := { grantState with grants := update grantState.grants childGrantId childGrant }
  refine ⟨after, ?_⟩
  apply Step.delegate (parentGrant := rootGrant) (childGrant := childGrant)
  · simp [grantState, facetState, environmentState, agentState, workspaceState, tenantState, rootGrantId]
  · exact rootLiveAtGrantState
  · rfl
  · rfl
  · intro requested member
    simpa [childGrant, rootGrant] using member
  · exact childScoped
  · change (default : State).grants childGrantId = none
    rfl

private theorem createTenantStep :
    Step (default : State) (.createTenant tenant) .accepted tenantState := by
  apply Step.createTenant
  · rfl
  · intro candidate owner
    exact owner

private theorem createWorkspaceStep :
    Step tenantState (.createWorkspace workspace) .accepted workspaceState := by
  apply Step.createWorkspace (workspace := traceWorkspace) (principal := principal)
    (tenant := traceTenant)
  · rfl
  · simp [tenantState, traceWorkspace, tenant]
  · rfl

private theorem createAgentStep :
    Step workspaceState (.createAgent agent) .accepted agentState := by
  apply Step.createAgent (agent := traceAgent) (workspace := traceWorkspace)
    (tenant := traceTenant) (principal := principal)
  · rfl
  · simp [workspaceState, tenantState, traceAgent, workspace]
  · rfl
  · simp [workspaceState, tenantState, traceAgent, tenant]
  · rfl

private theorem createEnvironmentStep :
    Step agentState (.createEnvironment environment) .accepted environmentState := by
  apply Step.createEnvironment (environment := traceEnvironment) (tenant := traceTenant) (principal := principal)
  · rfl
  · simp [agentState, workspaceState, tenantState, traceEnvironment, tenant]
  · rfl

private theorem installFacetStep :
    Step environmentState (.installFacet facetId) .accepted facetState := by
  apply Step.installFacet (workspace := traceWorkspace)
  · rfl
  · simp [environmentState, agentState, workspaceState, tenantState, traceFacet, workspace]
  · rfl

private theorem issueRootGrantStep :
    Step facetState (.issueRootGrant rootGrantId) .accepted grantState := by
  apply Step.issueRootGrant (grant := rootGrant) (principal := principal) (tenant := traceTenant)
  · rfl
  · change update (default : State).tenants tenant traceTenant tenant = some traceTenant
    exact update_eq _ _ _
  · rfl
  · rfl
  · exact rootScoped

private theorem bindStep :
    Step grantState (.bind bindingId) .accepted bindingState := by
  apply Step.bind (binding := rootBinding) (grant := rootGrant) (facet := traceFacet)
  · rfl
  · simp [grantState, facetState, environmentState, agentState, workspaceState, tenantState,
      rootBinding, rootGrantId]
  · simp [grantState, facetState, environmentState, agentState, workspaceState, tenantState,
      rootBinding, facetId]
  · rfl
  · rfl
  · exact rootLiveAtGrantState

private theorem startRunStep :
    Step bindingState (.startRun runId) .accepted runState := by
  apply Step.startRun (run := sessionRun) (environment := traceEnvironment)
    (agent := traceAgent) (workspace := traceWorkspace)
  · rfl
  · simp [bindingState, grantState, facetState, environmentState, agentState, workspaceState,
      tenantState, sessionRun, agent]
  · rfl
  · rfl
  · simp [bindingState, grantState, facetState, environmentState, agentState, workspaceState,
      tenantState, sessionRun, workspace]
  · rfl
  · simp [bindingState, grantState, facetState, environmentState, agentState, workspaceState,
      tenantState, sessionRun, traceEnvironment, environment]
  · rfl

private theorem createBranchStep :
    Step runState (.createBranch branchId) .accepted branchState := by
  apply Step.createBranch (branch := rootBranch) (run := sessionRun)
    (parent := branchId) (parentBranch := rootBranch)
  · rfl
  · simp [runState, bindingState, grantState, facetState, environmentState, agentState,
      workspaceState, tenantState, rootBranch, runId]
  · exact Or.inl rfl

private theorem startTurnStep :
    Step branchState (.startTurn turnId) .accepted queuedTurnState := by
  apply Step.startTurn (turn := queuedTurn) (run := sessionRun) (branch := rootBranch)
  · rfl
  · simp [branchState, runState, bindingState, grantState, facetState, environmentState,
      agentState, workspaceState, tenantState, queuedTurn, runId]
  · simp [branchState, runState, bindingState, grantState, facetState, environmentState,
      agentState, workspaceState, tenantState, queuedTurn, rootBranch, branchId]
  · rfl
  · rfl
  · rfl
  · rfl

private theorem claimTurnStep :
    Step queuedTurnState (.claimTurn turnId) .accepted runningState := by
  apply Step.claimTurn (turn := queuedTurn) (epoch := 1)
  · simp [queuedTurnState, branchState, runState, bindingState, grantState, facetState,
      environmentState, agentState, workspaceState, tenantState, turnId]
  · exact Or.inl rfl
  · change 1 > queuedTurn.leaseEpoch
    simp [queuedTurn]

private theorem acceptedInvocationStep :
    Step runningState (.invocation .audit acceptedReceipt) .accepted runningState := by
  exact nonvacuous_authorized_invocation

private theorem revokeStep :
    Step runningState (.revoke rootGrantId) .accepted revokedState := by
  exact Step.revoke

private theorem revokedNotAuthorized :
    ¬AuthorizedBy revokedState domain bindingId permission := by
  intro authorizedAfterRevoke
  obtain ⟨binding, grant, bindingLookup, bindingTarget, grantLookup, grantTarget, member,
    scopeProof, live, chain⟩ := authorizedAfterRevoke
  have bindingEqual : binding = rootBinding := by
    simpa [revokedState, runningState, queuedTurnState, branchState, runState, bindingState,
      grantState, facetState, environmentState, agentState, workspaceState, tenantState,
      bindingId] using Option.some.inj bindingLookup.symm
  subst binding
  apply (liveGrant_not_revoked live)
  exact Or.inr rfl

private theorem deniedInvocationStep :
    Step revokedState (.deniedInvocation invocation) .denied revokedState := by
  apply Step.deniedInvocation
  intro requirements
  exact revokedNotAuthorized requirements.left

private def traceLabels : List Label :=
  [.createTenant tenant, .createWorkspace workspace, .createAgent agent,
    .createEnvironment environment, .installFacet facetId,
    .issueRootGrant rootGrantId, .bind bindingId, .startRun runId,
    .createBranch branchId, .startTurn turnId, .claimTurn turnId,
    .invocation .audit acceptedReceipt, .revoke rootGrantId,
    .deniedInvocation invocation]

theorem nontrivial_reachable_exec :
    Exec (default : State) traceLabels revokedState := by
  apply Exec.cons createTenantStep
  apply Exec.cons createWorkspaceStep
  apply Exec.cons createAgentStep
  apply Exec.cons createEnvironmentStep
  apply Exec.cons installFacetStep
  apply Exec.cons issueRootGrantStep
  apply Exec.cons bindStep
  apply Exec.cons startRunStep
  apply Exec.cons createBranchStep
  apply Exec.cons startTurnStep
  apply Exec.cons claimTurnStep
  apply Exec.cons acceptedInvocationStep
  apply Exec.cons revokeStep
  apply Exec.cons deniedInvocationStep
  exact Exec.nil _

theorem nontrivial_final_state_reachable : Reachable revokedState := by
  apply reachable_of_exec (Reachable.initial rfl)
  exact nontrivial_reachable_exec

theorem nontrivial_final_state_wellFormed : WellFormed revokedState :=
  reachable_wellFormed nontrivial_final_state_reachable

end AgentCore.Examples
