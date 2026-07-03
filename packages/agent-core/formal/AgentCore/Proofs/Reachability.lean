import AgentCore.Proofs.Safety

namespace AgentCore

private theorem update_preserves_some [DecidableEq α] {table : α → Option β} {key other : α}
    {value old : β} (fresh : table key = none) (lookup : table other = some old) :
    update table key value other = some old := by
  have different : other ≠ key := by
    intro equal
    rw [equal, fresh] at lookup
    contradiction
  rw [update_ne _ _ _ different, lookup]

private theorem grantChain_after_insert {state : State} {id : GrantId} {grant : Grant}
    (fresh : state.grants id = none) {child root : GrantId}
    (chain : GrantChain state child root) :
    GrantChain { state with grants := update state.grants id grant } child root := by
  induction chain with
  | root lookup parentNone =>
      exact GrantChain.root (update_preserves_some fresh lookup) parentNone
  | child childLookup parentSome parentLookup subset sameTenant parentChain ih =>
      exact GrantChain.child
        (update_preserves_some fresh childLookup)
        parentSome
        (update_preserves_some fresh parentLookup)
        subset
        sameTenant
        ih

private theorem grantChain_of_same_grants {before after : State}
    (same : ∀ id, after.grants id = before.grants id) {child root : GrantId}
    (chain : GrantChain before child root) : GrantChain after child root := by
  induction chain with
  | root lookup parentNone =>
      exact GrantChain.root (by rw [same]; exact lookup) parentNone
  | child childLookup parentSome parentLookup subset sameTenant parentChain ih =>
      exact GrantChain.child
        (by rw [same]; exact childLookup)
        parentSome
        (by rw [same]; exact parentLookup)
        subset
        sameTenant
        ih

private theorem grants_have_chains_of_same_grants {before after : State}
    (wellFormed : WellFormed before) (same : ∀ id, after.grants id = before.grants id) :
    ∀ id grant, after.grants id = some grant → ∃ root, GrantChain after id root := by
  intro id grant lookup
  have beforeLookup : before.grants id = some grant := by
    rw [← same id]
    exact lookup
  obtain ⟨root, chain⟩ := wellFormed.grantsHaveChains id grant beforeLookup
  exact ⟨root, grantChain_of_same_grants same chain⟩

private theorem run_pinned_after_fresh_environment_insert {state : State}
    {environmentId : EnvironmentId} {environment : Environment}
    (environmentFresh : state.environments environmentId = none)
    (wellFormed : WellFormed state) {id : RunId} {run : Run}
    (lookup : state.runs id = some run) :
    ∃ existingEnvironment,
      update state.environments environmentId environment run.environment = some existingEnvironment ∧
      existingEnvironment.tenant = run.tenant := by
  obtain ⟨existingEnvironment, environmentLookup, tenant⟩ := wellFormed.runsArePinned id run lookup
  exact ⟨existingEnvironment, update_preserves_some environmentFresh environmentLookup, tenant⟩

private theorem initial_wellFormed_default : WellFormed (default : State) := by
  constructor
  · intro id tenant lookup
    contradiction
  · intro id workspace lookup
    contradiction
  · intro id grant lookup
    contradiction
  · intro id grant lookup
    contradiction
  · intro id grant lookup
    contradiction
  · intro id binding lookup
    contradiction
  · intro id environment lookup
    contradiction
  · intro id run lookup
    contradiction
  · intro id agent lookup
    contradiction
  · intro id run lookup
    contradiction

theorem initial_wellFormed {state : State} (initial : Initial state) : WellFormed state := by
  rw [initial]
  exact initial_wellFormed_default

private theorem wellFormed_ignores_branch_commit_turns {state : State}
    (branches : BranchId → Option Branch)
    (commits : CommitId → Option Commit)
    (turns : TurnId → Option Turn)
    (wellFormed : WellFormed state) :
    WellFormed { state with branches := branches, commits := commits, turns := turns } := by
  constructor
  · exact wellFormed.ownersAreMembers
  · exact wellFormed.workspacesHaveTenants
  · exact wellFormed.grantsHaveTenants
  · exact wellFormed.grantsAreScoped
  · exact grants_have_chains_of_same_grants wellFormed (fun _ => rfl)
  · exact wellFormed.bindingsMatchGrants
  · exact wellFormed.environmentsAreValid
  · exact wellFormed.runsArePinned
  · exact wellFormed.agentsHaveWorkspaces
  · exact wellFormed.runsHaveAgents

theorem step_preserves_wellFormed {before after : State} {label : Label} {outcome : Outcome}
    (wellFormed : WellFormed before) (step : Step before label outcome after) :
    WellFormed after := by
  cases step with
  | @createTenant newId newTenant fresh owners =>
      constructor
      · intro id existingTenant lookup principal owner
        by_cases equal : id = newId
        · subst id
          change update before.tenants newId newTenant newId = some existingTenant at lookup
          rw [update_eq] at lookup
          cases Option.some.inj lookup
          exact owners principal owner
        · exact wellFormed.ownersAreMembers id existingTenant
            (by simpa only using update_ne before.tenants _ id equal _ ▸ lookup) principal owner
      · intro id workspace lookup
        obtain ⟨tenant, tenantLookup⟩ := wellFormed.workspacesHaveTenants id workspace lookup
        exact ⟨tenant, update_preserves_some fresh tenantLookup⟩
      · intro id grant lookup
        obtain ⟨tenant, tenantLookup⟩ := wellFormed.grantsHaveTenants id grant lookup
        exact ⟨tenant, update_preserves_some fresh tenantLookup⟩
      · exact wellFormed.grantsAreScoped
      · exact grants_have_chains_of_same_grants wellFormed (fun _ => rfl)
      · exact wellFormed.bindingsMatchGrants
      · intro id environment lookup
        obtain ⟨tenant, tenantLookup⟩ :=
          wellFormed.environmentsAreValid id environment lookup
        exact ⟨tenant, update_preserves_some fresh tenantLookup⟩
      · exact wellFormed.runsArePinned
      · intro id agent lookup
        obtain ⟨workspace, tenant, workspaceLookup, workspaceTenant, tenantLookup⟩ :=
          wellFormed.agentsHaveWorkspaces id agent lookup
        exact ⟨workspace, tenant, workspaceLookup, workspaceTenant,
          update_preserves_some fresh tenantLookup⟩
      · exact wellFormed.runsHaveAgents
  | @createWorkspace newId newWorkspace principal tenant fresh tenantLookup owner =>
      constructor
      · exact wellFormed.ownersAreMembers
      · intro id existing lookup
        by_cases equal : id = newId
        · subst id
          change update before.workspaces newId newWorkspace newId = some existing at lookup
          rw [update_eq] at lookup
          cases Option.some.inj lookup
          exact ⟨_, tenantLookup⟩
        · exact wellFormed.workspacesHaveTenants id existing
            (by simpa only using update_ne before.workspaces _ id equal _ ▸ lookup)
      · exact wellFormed.grantsHaveTenants
      · exact wellFormed.grantsAreScoped
      · exact grants_have_chains_of_same_grants wellFormed (fun _ => rfl)
      · exact wellFormed.bindingsMatchGrants
      · exact wellFormed.environmentsAreValid
      · exact wellFormed.runsArePinned
      · intro id agent lookup
        obtain ⟨workspace, tenant, workspaceLookup, workspaceTenant, agentTenantLookup⟩ :=
          wellFormed.agentsHaveWorkspaces id agent lookup
        exact ⟨workspace, tenant, update_preserves_some fresh workspaceLookup,
          workspaceTenant, agentTenantLookup⟩
      · exact wellFormed.runsHaveAgents
  | @createAgent newId newAgent workspace tenant principal fresh workspaceLookup workspaceTenant tenantLookup owner =>
      constructor
      · exact wellFormed.ownersAreMembers
      · exact wellFormed.workspacesHaveTenants
      · exact wellFormed.grantsHaveTenants
      · exact wellFormed.grantsAreScoped
      · exact grants_have_chains_of_same_grants wellFormed (fun _ => rfl)
      · exact wellFormed.bindingsMatchGrants
      · exact wellFormed.environmentsAreValid
      · exact wellFormed.runsArePinned
      · intro id existing lookup
        by_cases equal : id = newId
        · subst id
          change update before.agents newId newAgent newId = some existing at lookup
          rw [update_eq] at lookup
          cases Option.some.inj lookup
          exact ⟨workspace, tenant, workspaceLookup, workspaceTenant, tenantLookup⟩
        · exact wellFormed.agentsHaveWorkspaces id existing
            (by simpa only using update_ne before.agents _ id equal _ ▸ lookup)
      · intro id run lookup
        obtain ⟨existingAgent, agentLookup, agentTenant, agentWorkspace⟩ :=
          wellFormed.runsHaveAgents id run lookup
        exact ⟨existingAgent, update_preserves_some fresh agentLookup, agentTenant, agentWorkspace⟩
  | @createEnvironment environmentId environment tenant principal environmentFresh tenantLookup owner =>
      constructor
      · exact wellFormed.ownersAreMembers
      · exact wellFormed.workspacesHaveTenants
      · exact wellFormed.grantsHaveTenants
      · exact wellFormed.grantsAreScoped
      · exact grants_have_chains_of_same_grants wellFormed (fun _ => rfl)
      · exact wellFormed.bindingsMatchGrants
      · intro id existing lookup
        by_cases equal : id = environmentId
        · subst id
          change update before.environments environmentId environment environmentId = some existing at lookup
          rw [update_eq] at lookup
          cases Option.some.inj lookup
          exact ⟨_, tenantLookup⟩
        · obtain ⟨tenant, existingTenantLookup⟩ :=
            wellFormed.environmentsAreValid id existing
              (by simpa only using update_ne before.environments _ id equal _ ▸ lookup)
          exact ⟨tenant, existingTenantLookup⟩
      · exact fun id run lookup =>
          run_pinned_after_fresh_environment_insert environmentFresh wellFormed lookup
      · exact wellFormed.agentsHaveWorkspaces
      · exact wellFormed.runsHaveAgents
  | @installFacet facetId facet workspace fresh workspaceLookup workspaceTenant =>
      constructor
      · exact wellFormed.ownersAreMembers
      · exact wellFormed.workspacesHaveTenants
      · exact wellFormed.grantsHaveTenants
      · exact wellFormed.grantsAreScoped
      · exact grants_have_chains_of_same_grants wellFormed (fun _ => rfl)
      · intro id binding lookup
        obtain ⟨grant, existingFacet, grantLookup, facetLookup, target, facetTarget⟩ :=
          wellFormed.bindingsMatchGrants id binding lookup
        exact ⟨grant, existingFacet, grantLookup, update_preserves_some fresh facetLookup,
          target, facetTarget⟩
      · exact wellFormed.environmentsAreValid
      · exact wellFormed.runsArePinned
      · exact wellFormed.agentsHaveWorkspaces
      · exact wellFormed.runsHaveAgents
  | @issueRootGrant grantId grant principal tenant fresh tenantLookup owner parent scopeProof =>
      constructor
      · exact wellFormed.ownersAreMembers
      · exact wellFormed.workspacesHaveTenants
      · intro id existing lookup
        by_cases equal : id = grantId
        · subst id
          change update before.grants grantId grant grantId = some existing at lookup
          rw [update_eq] at lookup
          cases Option.some.inj lookup
          exact ⟨_, tenantLookup⟩
        · exact wellFormed.grantsHaveTenants id existing
            (by simpa only using update_ne before.grants _ id equal _ ▸ lookup)
      · intro id existing lookup
        by_cases equal : id = grantId
        · subst id
          change update before.grants grantId grant grantId = some existing at lookup
          rw [update_eq] at lookup
          cases Option.some.inj lookup
          exact scopeProof
        · exact wellFormed.grantsAreScoped id existing
            (by simpa only using update_ne before.grants _ id equal _ ▸ lookup)
      · intro id existing lookup
        by_cases equal : id = grantId
        · subst id
          change update before.grants grantId grant grantId = some existing at lookup
          rw [update_eq] at lookup
          cases Option.some.inj lookup
          exact ⟨_, GrantChain.root (update_eq _ _ _) parent⟩
        · obtain ⟨root, chain⟩ := wellFormed.grantsHaveChains id existing
            (by simpa only using update_ne before.grants _ id equal _ ▸ lookup)
          exact ⟨root, grantChain_after_insert fresh chain⟩
      · intro id binding lookup
        obtain ⟨existing, facet, grantLookup, facetLookup, target, facetTarget⟩ :=
          wellFormed.bindingsMatchGrants id binding lookup
        exact ⟨existing, facet, update_preserves_some fresh grantLookup, facetLookup,
          target, facetTarget⟩
      · exact wellFormed.environmentsAreValid
      · exact wellFormed.runsArePinned
      · exact wellFormed.agentsHaveWorkspaces
      · exact wellFormed.runsHaveAgents
  | @delegate parentId childId parentGrant childGrant parentLookup live parentEdge sameTenant subset scopeProof fresh =>
      have parentDifferent : parentId ≠ childId := by
        intro equal
        rw [equal, fresh] at parentLookup
        contradiction
      constructor
      · exact wellFormed.ownersAreMembers
      · exact wellFormed.workspacesHaveTenants
      · intro id existing lookup
        by_cases equal : id = childId
        · subst id
          change update before.grants childId childGrant childId = some existing at lookup
          rw [update_eq] at lookup
          cases Option.some.inj lookup
          obtain ⟨tenant, tenantLookup⟩ := wellFormed.grantsHaveTenants _ _ parentLookup
          exact ⟨tenant, by simpa only [sameTenant] using tenantLookup⟩
        · exact wellFormed.grantsHaveTenants id existing
            (by simpa only using update_ne before.grants _ id equal _ ▸ lookup)
      · intro id existing lookup
        by_cases equal : id = childId
        · subst id
          change update before.grants childId childGrant childId = some existing at lookup
          rw [update_eq] at lookup
          cases Option.some.inj lookup
          exact scopeProof
        · exact wellFormed.grantsAreScoped id existing
            (by simpa only using update_ne before.grants _ id equal _ ▸ lookup)
      · intro id existing lookup
        by_cases equal : id = childId
        · subst id
          change update before.grants childId childGrant childId = some existing at lookup
          rw [update_eq] at lookup
          cases Option.some.inj lookup
          obtain ⟨root, parentChain⟩ := wellFormed.grantsHaveChains _ _ parentLookup
          exact ⟨root, GrantChain.child (update_eq _ _ _) parentEdge
            (by change update before.grants childId childGrant parentId = some parentGrant
                rw [update_ne before.grants childId parentId parentDifferent childGrant, parentLookup])
            subset sameTenant (grantChain_after_insert fresh parentChain)⟩
        · obtain ⟨root, chain⟩ := wellFormed.grantsHaveChains id existing
            (by simpa only using update_ne before.grants _ id equal _ ▸ lookup)
          exact ⟨root, grantChain_after_insert fresh chain⟩
      · intro id binding lookup
        obtain ⟨existing, facet, grantLookup, facetLookup, target, facetTarget⟩ :=
          wellFormed.bindingsMatchGrants id binding lookup
        exact ⟨existing, facet, update_preserves_some fresh grantLookup, facetLookup,
          target, facetTarget⟩
      · exact wellFormed.environmentsAreValid
      · exact wellFormed.runsArePinned
      · exact wellFormed.agentsHaveWorkspaces
      · exact wellFormed.runsHaveAgents
  | @bind bindingId binding grant facet fresh grantLookup facetLookup target facetTarget live =>
      constructor
      · exact wellFormed.ownersAreMembers
      · exact wellFormed.workspacesHaveTenants
      · exact wellFormed.grantsHaveTenants
      · exact wellFormed.grantsAreScoped
      · exact grants_have_chains_of_same_grants wellFormed (fun _ => rfl)
      · intro id existing lookup
        by_cases equal : id = bindingId
        · subst id
          change update before.bindings bindingId binding bindingId = some existing at lookup
          rw [update_eq] at lookup
          cases Option.some.inj lookup
          exact ⟨_, _, grantLookup, facetLookup, target, facetTarget⟩
        · exact wellFormed.bindingsMatchGrants id existing
            (by simpa only using update_ne before.bindings _ id equal _ ▸ lookup)
      · exact wellFormed.environmentsAreValid
      · exact wellFormed.runsArePinned
      · exact wellFormed.agentsHaveWorkspaces
      · exact wellFormed.runsHaveAgents
  | acceptEvent =>
      constructor
      · exact wellFormed.ownersAreMembers
      · exact wellFormed.workspacesHaveTenants
      · exact wellFormed.grantsHaveTenants
      · exact wellFormed.grantsAreScoped
      · exact grants_have_chains_of_same_grants wellFormed (fun _ => rfl)
      · exact wellFormed.bindingsMatchGrants
      · exact wellFormed.environmentsAreValid
      · exact wellFormed.runsArePinned
      · exact wellFormed.agentsHaveWorkspaces
      · exact wellFormed.runsHaveAgents
  | createSubscription =>
      constructor
      · exact wellFormed.ownersAreMembers
      · exact wellFormed.workspacesHaveTenants
      · exact wellFormed.grantsHaveTenants
      · exact wellFormed.grantsAreScoped
      · exact grants_have_chains_of_same_grants wellFormed (fun _ => rfl)
      · exact wellFormed.bindingsMatchGrants
      · exact wellFormed.environmentsAreValid
      · exact wellFormed.runsArePinned
      · exact wellFormed.agentsHaveWorkspaces
      · exact wellFormed.runsHaveAgents
  | fireSubscription =>
      constructor
      · exact wellFormed.ownersAreMembers
      · exact wellFormed.workspacesHaveTenants
      · exact wellFormed.grantsHaveTenants
      · exact wellFormed.grantsAreScoped
      · exact grants_have_chains_of_same_grants wellFormed (fun _ => rfl)
      · exact wellFormed.bindingsMatchGrants
      · exact wellFormed.environmentsAreValid
      · exact wellFormed.runsArePinned
      · exact wellFormed.agentsHaveWorkspaces
      · exact wellFormed.runsHaveAgents
  | emitCommittedEvent =>
      constructor
      · exact wellFormed.ownersAreMembers
      · exact wellFormed.workspacesHaveTenants
      · exact wellFormed.grantsHaveTenants
      · exact wellFormed.grantsAreScoped
      · exact grants_have_chains_of_same_grants wellFormed (fun _ => rfl)
      · exact wellFormed.bindingsMatchGrants
      · exact wellFormed.environmentsAreValid
      · exact wellFormed.runsArePinned
      · exact wellFormed.agentsHaveWorkspaces
      · exact wellFormed.runsHaveAgents
  | revoke =>
      constructor
      · exact wellFormed.ownersAreMembers
      · exact wellFormed.workspacesHaveTenants
      · exact wellFormed.grantsHaveTenants
      · exact wellFormed.grantsAreScoped
      · exact grants_have_chains_of_same_grants wellFormed (fun _ => rfl)
      · exact wellFormed.bindingsMatchGrants
      · exact wellFormed.environmentsAreValid
      · exact wellFormed.runsArePinned
      · exact wellFormed.agentsHaveWorkspaces
      · exact wellFormed.runsHaveAgents
  | @startRun runId run agent workspace environment fresh agentLookup agentTenant agentWorkspace workspaceLookup workspaceTenant environmentLookup environmentTenant =>
      constructor
      · exact wellFormed.ownersAreMembers
      · exact wellFormed.workspacesHaveTenants
      · exact wellFormed.grantsHaveTenants
      · exact wellFormed.grantsAreScoped
      · exact grants_have_chains_of_same_grants wellFormed (fun _ => rfl)
      · exact wellFormed.bindingsMatchGrants
      · exact wellFormed.environmentsAreValid
      · intro id existing lookup
        by_cases equal : id = runId
        · subst id
          change update before.runs runId run runId = some existing at lookup
          rw [update_eq] at lookup
          cases Option.some.inj lookup
          exact ⟨_, environmentLookup, environmentTenant⟩
        · exact wellFormed.runsArePinned id existing
            (by simpa only using update_ne before.runs _ id equal _ ▸ lookup)
      · exact wellFormed.agentsHaveWorkspaces
      · intro id existing lookup
        by_cases equal : id = runId
        · subst id
          change update before.runs runId run runId = some existing at lookup
          rw [update_eq] at lookup
          cases Option.some.inj lookup
          exact ⟨agent, agentLookup, agentTenant, agentWorkspace⟩
        · exact wellFormed.runsHaveAgents id existing
            (by simpa only using update_ne before.runs _ id equal _ ▸ lookup)
  | createBranch => exact wellFormed_ignores_branch_commit_turns _ _ _ wellFormed
  | commitBranch => exact wellFormed_ignores_branch_commit_turns _ _ _ wellFormed
  | startTurn => exact wellFormed_ignores_branch_commit_turns _ _ _ wellFormed
  | spawnTurn => exact wellFormed_ignores_branch_commit_turns _ _ _ wellFormed
  | retryTurn => exact wellFormed_ignores_branch_commit_turns _ _ _ wellFormed
  | resumeTurn => exact wellFormed_ignores_branch_commit_turns _ _ _ wellFormed
  | claimTurn => exact wellFormed_ignores_branch_commit_turns _ _ _ wellFormed
  | transitionTurn => exact wellFormed_ignores_branch_commit_turns _ _ _ wellFormed
  | @rotateEnvironment environmentId environment environmentLookup =>
      constructor
      · exact wellFormed.ownersAreMembers
      · exact wellFormed.workspacesHaveTenants
      · exact wellFormed.grantsHaveTenants
      · exact wellFormed.grantsAreScoped
      · exact grants_have_chains_of_same_grants wellFormed (fun _ => rfl)
      · exact wellFormed.bindingsMatchGrants
      · exact wellFormed.environmentsAreValid
      · exact wellFormed.runsArePinned
      · exact wellFormed.agentsHaveWorkspaces
      · exact wellFormed.runsHaveAgents
  | invocation => exact wellFormed
  | deniedInvocation => exact wellFormed

theorem reachable_wellFormed {state : State} (reachable : Reachable state) : WellFormed state := by
  induction reachable with
  | initial initial => exact initial_wellFormed initial
  | step reachable step wellFormed => exact step_preserves_wellFormed wellFormed step

theorem reachable_run_is_pinned {state : State} (reachable : Reachable state)
    {id : RunId} {run : Run} (lookup : state.runs id = some run) :
    ∃ environment,
      state.environments run.environment = some environment ∧
      environment.tenant = run.tenant :=
  (reachable_wellFormed reachable).runsArePinned id run lookup

theorem exec_preserves_wellFormed {before after : State} {labels : List Label}
    (wellFormed : WellFormed before) (execution : Exec before labels after) : WellFormed after := by
  induction execution with
  | nil => exact wellFormed
  | cons step tail ih => exact ih (step_preserves_wellFormed wellFormed step)

theorem reachable_of_exec {before after : State} {labels : List Label}
    (reachable : Reachable before) (execution : Exec before labels after) : Reachable after := by
  induction execution with
  | nil => exact reachable
  | cons step tail ih => exact ih (Reachable.step reachable step)

end AgentCore
