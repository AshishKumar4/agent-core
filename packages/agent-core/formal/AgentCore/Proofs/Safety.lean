import AgentCore.Model

namespace AgentCore

@[simp] theorem update_eq [DecidableEq α] (table : α → Option β) (key : α) (value : β) :
    update table key value key = some value := by
  simp [update]

@[simp] theorem update_ne [DecidableEq α] (table : α → Option β) (key other : α)
    (h : other ≠ key) (value : β) :
    update table key value other = table other := by
  simp [update, h]

theorem Authority.subset_refl (authority : Authority) : Authority.Subset authority authority := by
  intro permission member
  exact member

theorem Authority.subset_trans {a b c : Authority}
    (hab : Authority.Subset a b) (hbc : Authority.Subset b c) : Authority.Subset a c := by
  intro permission member
  exact hbc permission (hab permission member)

theorem wellScopedGrant_member {grant : Grant} {permission : Permission}
    (scopeProof : WellScopedGrant grant) (member : permission ∈ grant.authority) :
    permission.resource.tenant = grant.target.tenant :=
  scopeProof permission member

theorem grantChain_attenuates {state : State} {child root : GrantId}
    (chain : GrantChain state child root) :
    ∃ childGrant rootGrant,
      state.grants child = some childGrant ∧
      state.grants root = some rootGrant ∧
      Authority.Subset childGrant.authority rootGrant.authority := by
  induction chain with
  | root lookup parentNone =>
      exact ⟨_, _, lookup, lookup, Authority.subset_refl _⟩
  | child childLookup parentSome parentLookup subset sameTenant parentChain ih =>
      obtain ⟨parentChainGrant, rootGrant, chainParentLookup, rootLookup, parentRootSubset⟩ := ih
      rw [parentLookup] at chainParentLookup
      cases chainParentLookup
      exact ⟨_, rootGrant, childLookup, rootLookup,
        Authority.subset_trans subset parentRootSubset⟩

theorem liveGrant_not_revoked {state : State} {id : GrantId}
    (live : LiveGrant state id) : ¬state.revokedGrants id := by
  cases live with
  | root _ _ notRevoked => exact notRevoked
  | child _ _ notRevoked _ => exact notRevoked

theorem revoked_ancestor_disables_descendant {state : State} {child root : GrantId}
    (chain : GrantChain state child root)
    (revoked : state.revokedGrants root) :
    ¬LiveGrant state child := by
  induction chain with
  | root lookup parentNone =>
      intro live
      exact (liveGrant_not_revoked live) revoked
  | child childLookup parentSome parentLookup subset sameTenant parentChain ih =>
      intro live
      cases live with
      | root rootLookup rootParent rootNotRevoked =>
          rw [childLookup] at rootLookup
          cases Option.some.inj rootLookup
          rw [parentSome] at rootParent
          contradiction
      | child liveLookup liveParentSome notRevoked liveParent =>
          rw [childLookup] at liveLookup
          cases Option.some.inj liveLookup
          rw [parentSome] at liveParentSome
          cases Option.some.inj liveParentSome
          exact ih revoked liveParent

 theorem authorized_binding_exists {state : State} {domain : Domain}
    {bindingId : BindingId} {permission : Permission}
    (authorized : AuthorizedBy state domain bindingId permission) :
    ∃ binding, state.bindings bindingId = some binding ∧ binding.target = domain := by
  obtain ⟨binding, grant, bindingLookup, target, grantLookup, grantTarget,
    member, scopeProof, live, chain⟩ := authorized
  exact ⟨binding, bindingLookup, target⟩

theorem authorized_tenant_isolation {state : State} {domain : Domain}
    {bindingId : BindingId} {permission : Permission}
    (authorized : AuthorizedBy state domain bindingId permission) :
    permission.resource.tenant = domain.tenant := by
  obtain ⟨binding, grant, bindingLookup, bindingTarget, grantLookup, grantTarget,
    member, scopeProof, live, chain⟩ := authorized
  calc
    permission.resource.tenant = grant.target.tenant := wellScopedGrant_member scopeProof member
    _ = domain.tenant := congrArg Domain.tenant grantTarget

theorem authorized_authority_attenuates_to_root {state : State} {domain : Domain}
    {bindingId : BindingId} {permission : Permission}
    (authorized : AuthorizedBy state domain bindingId permission) :
    ∃ (childGrant rootGrant : Grant) (root : GrantId),
      state.grants root = some rootGrant ∧
      permission ∈ childGrant.authority ∧
      Authority.Subset childGrant.authority rootGrant.authority := by
  obtain ⟨binding, grant, bindingLookup, bindingTarget, grantLookup, grantTarget,
    member, scopeProof, live, root, chain⟩ := authorized
  obtain ⟨chainGrant, rootGrant, chainLookup, rootLookup, subset⟩ :=
    grantChain_attenuates chain
  rw [grantLookup] at chainLookup
  cases Option.some.inj chainLookup
  exact ⟨grant, rootGrant, root, rootLookup, member, subset⟩

theorem binding_cannot_cross_domains {state : State} {first second : Domain}
    {bindingId : BindingId} {firstPermission secondPermission : Permission}
    (different : first ≠ second)
    (firstAuthorized : AuthorizedBy state first bindingId firstPermission) :
    ¬AuthorizedBy state second bindingId secondPermission := by
  intro secondAuthorized
  obtain ⟨firstBinding, firstLookup, firstTarget⟩ := authorized_binding_exists firstAuthorized
  obtain ⟨secondBinding, secondLookup, secondTarget⟩ := authorized_binding_exists secondAuthorized
  rw [firstLookup] at secondLookup
  have equalBinding : firstBinding = secondBinding := Option.some.inj secondLookup
  apply different
  rw [← firstTarget, ← secondTarget, equalBinding]

theorem root_grant_requires_tenant_owner {before after : State} {id : GrantId}
    (step : Step before (.issueRootGrant id) .accepted after) :
    ∃ grant tenant principal,
      before.tenants grant.target.tenant = some tenant ∧
      tenant.owners principal ∧
      grant.parent = none ∧
      WellScopedGrant grant ∧
      after.grants id = some grant := by
  cases step with
  | issueRootGrant fresh tenantLookup owner parent scopeProof =>
      exact ⟨_, _, _, tenantLookup, owner, parent, scopeProof, update_eq _ _ _⟩

theorem workspace_creation_requires_owner {before after : State} {id : WorkspaceId}
    (step : Step before (.createWorkspace id) .accepted after) :
    ∃ workspace tenant principal,
      before.tenants workspace.tenant = some tenant ∧
      tenant.owners principal ∧
      after.workspaces id = some workspace := by
  cases step with
  | createWorkspace fresh tenantLookup owner =>
      exact ⟨_, _, _, tenantLookup, owner, update_eq _ _ _⟩

theorem start_run_requires_existing_agent_workspace {before after : State} {id : RunId}
    (step : Step before (.startRun id) .accepted after) :
    ∃ run agent workspace,
      after.runs id = some run ∧
      before.agents run.agent = some agent ∧
      before.workspaces run.workspace = some workspace ∧
      agent.tenant = run.tenant ∧
      agent.workspace = run.workspace ∧
      workspace.tenant = run.tenant := by
  cases step with
  | startRun fresh agentLookup agentTenant agentWorkspace workspaceLookup workspaceTenant environmentLookup environmentTenant =>
      exact ⟨_, _, _, update_eq _ _ _, agentLookup, workspaceLookup,
        agentTenant, agentWorkspace, workspaceTenant⟩

theorem create_branch_requires_run {before after : State} {id : BranchId}
    (step : Step before (.createBranch id) .accepted after) :
    ∃ branch run,
      after.branches id = some branch ∧
      before.runs branch.run = some run := by
  cases step with
  | createBranch fresh runLookup parentValid =>
      exact ⟨_, _, update_eq _ _ _, runLookup⟩

theorem commit_branch_requires_branch {before after : State} {id : CommitId}
    (step : Step before (.commitBranch id) .accepted after) :
    ∃ commit branch,
      after.commits id = some commit ∧
      before.branches commit.branch = some branch ∧
      branch.run = commit.run := by
  cases step with
  | commitBranch fresh branchLookup sameRun parentValid =>
      exact ⟨_, _, update_eq _ _ _, branchLookup, sameRun⟩

theorem start_turn_requires_run_branch {before after : State} {id : TurnId}
    (step : Step before (.startTurn id) .accepted after) :
    ∃ turn run branch,
      after.turns id = some turn ∧
      before.runs turn.run = some run ∧
      before.branches turn.branch = some branch ∧
      branch.run = turn.run := by
  cases step with
  | startTurn fresh runLookup branchLookup branchRun origin queued epoch =>
      exact ⟨_, _, _, update_eq _ _ _, runLookup, branchLookup, branchRun⟩

theorem start_turn_initial_lease {before after : State} {id : TurnId}
    (step : Step before (.startTurn id) .accepted after) :
    ∃ turn,
      after.turns id = some turn ∧
      turn.status = .queued ∧
      turn.leaseEpoch = 0 := by
  cases step with
  | startTurn fresh runLookup branchLookup branchRun origin queued epoch =>
      exact ⟨_, update_eq _ _ _, queued, epoch⟩

theorem claim_turn_requires_claimable_and_increases_epoch {before after : State} {id : TurnId}
    (step : Step before (.claimTurn id) .accepted after) :
    ∃ beforeTurn afterTurn,
      before.turns id = some beforeTurn ∧
      after.turns id = some afterTurn ∧
      (beforeTurn.status = .queued ∨ beforeTurn.status = .suspended) ∧
      afterTurn.status = .running ∧
      afterTurn.leaseEpoch > beforeTurn.leaseEpoch := by
  cases step with
  | claimTurn lookup claimable newer =>
      exact ⟨_, _, lookup, update_eq _ _ _, claimable, rfl, newer⟩

theorem delegated_authority_subset {before after : State} {parent child : GrantId}
    (step : Step before (.delegate parent child) .accepted after) :
    ∃ parentGrant childGrant,
      before.grants parent = some parentGrant ∧
      after.grants child = some childGrant ∧
      Authority.Subset childGrant.authority parentGrant.authority := by
  cases step with
  | delegate parentLookup live parentEdge tenant subset scopeProof fresh =>
      exact ⟨_, _, parentLookup, update_eq _ _ _, subset⟩

theorem revoke_step_preserves_prior_revocations {before after : State} {id : GrantId}
    (step : Step before (.revoke id) .accepted after) :
    ∀ grant, before.revokedGrants grant → after.revokedGrants grant := by
  cases step
  intro grant revoked
  exact Or.inl revoked

theorem step_revocation_monotone {before after : State} {label : Label} {outcome : Outcome}
    (step : Step before label outcome after) :
    ∀ grant, before.revokedGrants grant → after.revokedGrants grant := by
  cases step <;> intro grant wasRevoked
  all_goals try exact wasRevoked
  exact Or.inl wasRevoked

theorem exec_revocation_monotone {before after : State} {labels : List Label}
    (execution : Exec before labels after) :
    ∀ grant, before.revokedGrants grant → after.revokedGrants grant := by
  induction execution with
  | nil => exact fun _ revoked => revoked
  | cons step tail ih =>
      intro grant revoked
      exact ih grant (step_revocation_monotone step grant revoked)

theorem revoked_grant_after_revoke {before after : State} {id : GrantId}
    (step : Step before (.revoke id) .accepted after) :
    after.revokedGrants id := by
  cases step
  exact Or.inr rfl

theorem accepted_event_has_workspace {before after : State} {id : EventId}
    (step : Step before (.acceptEvent id) .accepted after) :
    ∃ event workspace,
      before.events id = none ∧
      after.events id = some event ∧
      before.workspaces event.workspace = some workspace ∧
      workspace.tenant = event.tenant := by
  cases step with
  | acceptEvent fresh workspaceLookup tenant facetLookup facetTenant facetWorkspace =>
      exact ⟨_, _, fresh, update_eq _ _ _, workspaceLookup, tenant⟩

theorem subscription_fire_requires_enabled {before after : State}
    {subscriptionId : SubscriptionId} {eventId : EventId} {receipt : Receipt}
    (step : Step before (.fireSubscription subscriptionId eventId receipt) .accepted after) :
    ∃ subscription event,
      before.subscriptions subscriptionId = some subscription ∧
      before.events eventId = some event ∧
      subscription.enabled = true ∧
      subscription.tenant = event.tenant ∧
      subscription.workspace = event.workspace ∧
      subscription.source = event.source := by
  cases step with
  | fireSubscription subscriptionLookup eventLookup enabled sameTenant sameWorkspace sameSource sameTarget sameTargetWorkspace sameOperation fresh outcome requirements ready =>
      exact ⟨_, _, subscriptionLookup, eventLookup, enabled, sameTenant, sameWorkspace, sameSource⟩

theorem subscription_fire_consumes_event_key {before after : State}
    {subscriptionId : SubscriptionId} {eventId : EventId} {receipt : Receipt}
    (step : Step before (.fireSubscription subscriptionId eventId receipt) .accepted after) :
    ∃ event,
      before.events eventId = some event ∧
      ¬before.consumedEvents subscriptionId event.key ∧
      after.consumedEvents subscriptionId event.key := by
  cases step with
  | fireSubscription subscriptionLookup eventLookup enabled sameTenant sameWorkspace sameSource sameTarget sameTargetWorkspace sameOperation fresh outcome requirements ready =>
      exact ⟨_, eventLookup, fresh, Or.inr ⟨rfl, rfl⟩⟩

theorem consumed_event_blocks_subscription_fire {state after : State}
    {subscriptionId : SubscriptionId} {eventId : EventId} {event : Event} {receipt : Receipt}
    (eventLookup : state.events eventId = some event)
    (consumed : state.consumedEvents subscriptionId event.key) :
    ¬Step state (.fireSubscription subscriptionId eventId receipt) .accepted after := by
  intro step
  cases step with
  | fireSubscription subscriptionLookup actualEventLookup enabled sameTenant sameWorkspace sameSource sameTarget sameTargetWorkspace sameOperation fresh outcome requirements ready =>
      rw [eventLookup] at actualEventLookup
      cases Option.some.inj actualEventLookup
      exact fresh consumed

theorem subscription_fire_invokes_declared_target {before after : State}
    {subscriptionId : SubscriptionId} {eventId : EventId} {receipt : Receipt}
    (step : Step before (.fireSubscription subscriptionId eventId receipt) .accepted after) :
    ∃ subscription,
      before.subscriptions subscriptionId = some subscription ∧
      receipt.invocation.domain = subscription.target ∧
      receipt.invocation.workspace = subscription.targetWorkspace ∧
      receipt.invocation.operation = subscription.operation := by
  cases step with
  | fireSubscription subscriptionLookup eventLookup enabled sameTenant sameWorkspace sameSource sameTarget sameTargetWorkspace sameOperation fresh outcome requirements ready =>
      exact ⟨_, subscriptionLookup, sameTarget, sameTargetWorkspace, sameOperation⟩

theorem subscription_invocation_satisfies_authorization {before after : State}
    {subscriptionId : SubscriptionId} {eventId : EventId} {receipt : Receipt}
    (step : Step before (.fireSubscription subscriptionId eventId receipt) .accepted after) :
    AuthorizedBy before receipt.invocation.domain
      receipt.invocation.authorization.binding receipt.invocation.authorization.permission := by
  cases step with
  | fireSubscription subscriptionLookup eventLookup enabled sameTenant sameWorkspace sameSource sameTarget sameTargetWorkspace sameOperation fresh outcome requirements ready =>
      exact requirements.left

theorem emitted_committed_event_matches_tenant {before after : State} {id : CommittedEventId}
    (step : Step before (.emitCommittedEvent id) .accepted after) :
    ∃ event,
      after.committedEvents id = some event ∧
      event.domain.tenant = event.tenant := by
  cases step with
  | emitCommittedEvent fresh tenant =>
      exact ⟨_, update_eq _ _ _, tenant⟩

theorem accepted_invocation_satisfies_requirements {before after : State}
    {kind : InvocationRecordKind} {receipt : Receipt}
    (step : Step before (.invocation kind receipt) .accepted after) :
    Invocation.RequirementsSatisfied before receipt.invocation := by
  cases step with
  | invocation outcome requirements ready => exact requirements

theorem accepted_invocation_satisfies_authorization {before after : State}
    {kind : InvocationRecordKind} {receipt : Receipt}
    (step : Step before (.invocation kind receipt) .accepted after) :
    AuthorizedBy before receipt.invocation.domain
      receipt.invocation.authorization.binding receipt.invocation.authorization.permission := by
  have requirements := accepted_invocation_satisfies_requirements step
  unfold Invocation.RequirementsSatisfied at requirements
  have authorized := requirements.left
  unfold Invocation.AuthorizationSatisfied at authorized
  exact authorized

theorem accepted_invocation_satisfies_approval {before after : State}
    {kind : InvocationRecordKind} {receipt : Receipt} {requirement : ApprovalRequirement}
    (step : Step before (.invocation kind receipt) .accepted after)
    (approval : receipt.invocation.approval = some requirement) :
    before.approvals receipt.invocation.domain requirement := by
  have requirements := accepted_invocation_satisfies_requirements step
  unfold Invocation.RequirementsSatisfied at requirements
  have approved := requirements.right
  unfold Invocation.ApprovalSatisfied at approved
  rw [approval] at approved
  exact approved

theorem accepted_invocation_preserves_state {before after : State}
    {kind : InvocationRecordKind} {receipt : Receipt}
    (step : Step before (.invocation kind receipt) .accepted after) :
    after = before := by
  cases step
  rfl

theorem denied_invocation_preserves_state {before after : State} {invocation : Invocation}
    (step : Step before (.deniedInvocation invocation) .denied after) :
    after = before := by
  cases step
  rfl

theorem denied_invocation_requirements_unsatisfied {before after : State}
    {invocation : Invocation}
    (step : Step before (.deniedInvocation invocation) .denied after) :
    ¬Invocation.RequirementsSatisfied before invocation := by
  cases step with
  | deniedInvocation unsatisfied => exact unsatisfied

theorem run_invocation_requires_running_turn {before after : State} {tenant : TenantId}
    {runId : RunId} {kind : InvocationRecordKind} {receipt : Receipt}
    (step : Step before (.invocation kind receipt) .accepted after)
    (domain : receipt.invocation.domain = .run tenant runId) :
    ∃ run turnId turn,
      before.runs runId = some run ∧
      before.turns turnId = some turn ∧
      turn.run = runId ∧
      turn.status = .running := by
  cases step with
  | invocation outcome requirements ready =>
      unfold Invocation.Ready at ready
      rw [domain] at ready
      obtain ⟨run, turnId, turn, lookup, tenantEq, workspaceEq, turnLookup, turnRun, running⟩ := ready
      exact ⟨run, turnId, turn, lookup, turnLookup, turnRun, running⟩

theorem spawn_turn_requires_running_parent {before after : State} {parentId childId : TurnId}
    (step : Step before (.spawnTurn parentId childId) .accepted after) :
    ∃ parent child,
      before.turns parentId = some parent ∧
      parent.status = .running ∧
      child.origin = .spawn parentId ∧
      child.run = parent.run ∧
      child.branch = parent.branch ∧
      after.turns childId = some child := by
  cases step with
  | spawnTurn parentLookup running fresh origin sameRun sameBranch queued epoch =>
      exact ⟨_, _, parentLookup, running, origin, sameRun, sameBranch, update_eq _ _ _⟩

theorem retry_turn_requires_retryable_parent {before after : State} {parentId retryId : TurnId}
    (step : Step before (.retryTurn parentId retryId) .accepted after) :
    ∃ parent retry,
      before.turns parentId = some parent ∧
      (parent.status = .failed ∨ parent.status = .interrupted) ∧
      retry.origin = .retry parentId ∧
      retry.run = parent.run ∧
      retry.branch = parent.branch ∧
      after.turns retryId = some retry := by
  cases step with
  | retryTurn parentLookup retryable fresh origin sameRun sameBranch queued epoch =>
      exact ⟨_, _, parentLookup, retryable, origin, sameRun, sameBranch, update_eq _ _ _⟩

theorem resume_turn_increases_lease_epoch {before after : State} {parentId resumedId : TurnId}
    (step : Step before (.resumeTurn parentId resumedId) .accepted after) :
    ∃ parent resumed,
      before.turns parentId = some parent ∧
      parent.status = .suspended ∧
      resumed.leaseEpoch > parent.leaseEpoch ∧
      after.turns resumedId = some resumed := by
  cases step with
  | resumeTurn parentLookup suspended fresh origin sameRun sameBranch newer queued =>
      exact ⟨_, _, parentLookup, suspended, newer, update_eq _ _ _⟩

theorem terminal_status_cannot_transition {status next : TurnStatus}
    (terminal : status = .succeeded ∨ status = .failed ∨ status = .cancelled ∨ status = .interrupted) :
    ¬CanTransition status next := by
  rcases terminal with rfl | rfl | rfl | rfl <;> cases next <;> simp [CanTransition]

theorem rotation_does_not_retarget_runs {before after : State}
    {environmentId : EnvironmentId}
    (step : Step before (.rotateEnvironment environmentId) .accepted after) :
    ∀ runId, after.runs runId = before.runs runId := by
  cases step
  intro runId
  rfl

inductive SafeExec : State → List Label → State → Prop
  | nil (state) : SafeExec state [] state
  | acceptedInvocation {start middle finish kind receipt labels} :
      Invocation.RequirementsSatisfied start receipt.invocation →
      Step start (.invocation kind receipt) .accepted middle →
      SafeExec middle labels finish →
      SafeExec start (.invocation kind receipt :: labels) finish
  | firedSubscription {start middle finish subscription event receipt labels} :
      Invocation.RequirementsSatisfied start receipt.invocation →
      Step start (.fireSubscription subscription event receipt) .accepted middle →
      SafeExec middle labels finish →
      SafeExec start (.fireSubscription subscription event receipt :: labels) finish
  | other {start middle finish label labels outcome} :
      (∀ kind receipt, label ≠ .invocation kind receipt) →
      Step start label outcome middle →
      SafeExec middle labels finish →
      SafeExec start (label :: labels) finish

theorem exec_all_invocations_mediated {start finish : State} {labels : List Label}
    (execution : Exec start labels finish) : SafeExec start labels finish := by
  induction execution with
  | nil => exact SafeExec.nil _
  | @cons start middle finish label labels outcome step tail ih =>
      cases label with
      | invocation kind receipt =>
          cases step with
          | invocation outcome requirements ready =>
              exact SafeExec.acceptedInvocation requirements
                (Step.invocation outcome requirements ready) ih
      | fireSubscription subscription event receipt =>
          cases step with
          | fireSubscription subscriptionLookup eventLookup enabled sameTenant sameWorkspace sameSource sameTarget sameTargetWorkspace sameOperation fresh outcome requirements ready =>
              exact SafeExec.firedSubscription requirements
                (Step.fireSubscription subscriptionLookup eventLookup enabled sameTenant sameWorkspace sameSource sameTarget sameTargetWorkspace sameOperation fresh outcome requirements ready) ih
      | createTenant id => exact SafeExec.other (by intros; simp) step ih
      | createWorkspace id => exact SafeExec.other (by intros; simp) step ih
      | createAgent id => exact SafeExec.other (by intros; simp) step ih
      | installFacet id => exact SafeExec.other (by intros; simp) step ih
      | createEnvironment environment => exact SafeExec.other (by intros; simp) step ih
      | issueRootGrant id => exact SafeExec.other (by intros; simp) step ih
      | delegate parent child => exact SafeExec.other (by intros; simp) step ih
      | bind id => exact SafeExec.other (by intros; simp) step ih
      | acceptEvent id => exact SafeExec.other (by intros; simp) step ih
      | createSubscription id => exact SafeExec.other (by intros; simp) step ih
      | emitCommittedEvent id => exact SafeExec.other (by intros; simp) step ih
      | revoke id => exact SafeExec.other (by intros; simp) step ih
      | startRun id => exact SafeExec.other (by intros; simp) step ih
      | createBranch id => exact SafeExec.other (by intros; simp) step ih
      | commitBranch id => exact SafeExec.other (by intros; simp) step ih
      | startTurn id => exact SafeExec.other (by intros; simp) step ih
      | spawnTurn parent child => exact SafeExec.other (by intros; simp) step ih
      | retryTurn parent retry => exact SafeExec.other (by intros; simp) step ih
      | resumeTurn parent resumed => exact SafeExec.other (by intros; simp) step ih
      | claimTurn id => exact SafeExec.other (by intros; simp) step ih
      | transitionTurn id status => exact SafeExec.other (by intros; simp) step ih
      | rotateEnvironment id => exact SafeExec.other (by intros; simp) step ih
      | deniedInvocation invocation => exact SafeExec.other (by intros; simp) step ih

theorem agentCore_invocation_authority_safety {before after : State}
    {kind : InvocationRecordKind} {receipt : Receipt}
    (step : Step before (.invocation kind receipt) .accepted after) :
    AuthorizedBy before receipt.invocation.domain
      receipt.invocation.authorization.binding receipt.invocation.authorization.permission ∧
    receipt.invocation.authorization.permission.resource.tenant = receipt.invocation.domain.tenant := by
  have authorized := accepted_invocation_satisfies_authorization step
  exact ⟨authorized, authorized_tenant_isolation authorized⟩

theorem same_binding_cannot_authorize_distinct_domains {state : State} {tenant : TenantId}
    {slate : SlateId} {run : RunId} {binding : BindingId}
    {slatePermission runPermission : Permission}
    (different : Domain.slate tenant slate ≠ Domain.run tenant run)
    (slateAuthorized : AuthorizedBy state (.slate tenant slate) binding slatePermission) :
    ¬AuthorizedBy state (.run tenant run) binding runPermission :=
  binding_cannot_cross_domains different slateAuthorized

end AgentCore
