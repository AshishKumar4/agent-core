import AgentCore.Scopes
import AgentCore.Approvals
import AgentCore.RunGraph
import AgentCore.Policy
import AgentCore.Composed
import AgentCore.Proofs.Safety
import AgentCore.Proofs.Reachability
import AgentCore.Examples
import AgentCore.Facet

#print axioms AgentCore.grantChain_attenuates
#print axioms AgentCore.authorized_authority_attenuates_to_root
#print axioms AgentCore.authorized_tenant_isolation
#print axioms AgentCore.binding_cannot_cross_domains
#print axioms AgentCore.delegated_authority_subset
#print axioms AgentCore.revoked_ancestor_disables_descendant
#print axioms AgentCore.step_revocation_monotone
#print axioms AgentCore.exec_revocation_monotone
#print axioms AgentCore.start_run_requires_existing_agent_workspace
#print axioms AgentCore.create_branch_requires_run
#print axioms AgentCore.commit_branch_requires_branch
#print axioms AgentCore.start_turn_requires_run_branch
#print axioms AgentCore.start_turn_initial_lease
#print axioms AgentCore.claim_turn_requires_claimable_and_increases_epoch
#print axioms AgentCore.accepted_event_has_workspace
#print axioms AgentCore.subscription_fire_requires_enabled
#print axioms AgentCore.subscription_fire_consumes_event_key
#print axioms AgentCore.consumed_event_blocks_subscription_fire
#print axioms AgentCore.subscription_fire_invokes_declared_target
#print axioms AgentCore.subscription_invocation_satisfies_authorization
#print axioms AgentCore.emitted_committed_event_matches_tenant
#print axioms AgentCore.accepted_invocation_satisfies_requirements
#print axioms AgentCore.accepted_invocation_satisfies_authorization
#print axioms AgentCore.accepted_invocation_satisfies_approval
#print axioms AgentCore.accepted_invocation_preserves_state
#print axioms AgentCore.denied_invocation_preserves_state
#print axioms AgentCore.denied_invocation_requirements_unsatisfied
#print axioms AgentCore.run_invocation_requires_running_turn
#print axioms AgentCore.exec_all_invocations_mediated
#print axioms AgentCore.agentCore_invocation_authority_safety
#print axioms AgentCore.spawn_turn_requires_running_parent
#print axioms AgentCore.retry_turn_requires_retryable_parent
#print axioms AgentCore.resume_turn_increases_lease_epoch
#print axioms AgentCore.terminal_status_cannot_transition
#print axioms AgentCore.rotation_does_not_retarget_runs
#print axioms AgentCore.same_binding_cannot_authorize_distinct_domains
#print axioms AgentCore.hermes_mixture_of_agents_representable
#print axioms AgentCore.initial_wellFormed
#print axioms AgentCore.step_preserves_wellFormed
#print axioms AgentCore.reachable_wellFormed
#print axioms AgentCore.reachable_run_is_pinned
#print axioms AgentCore.exec_preserves_wellFormed
#print axioms AgentCore.reachable_of_exec
#print axioms AgentCore.Examples.nontrivial_final_state_reachable
#print axioms AgentCore.Examples.nontrivial_final_state_wellFormed
#print axioms AgentCore.Facet.filesystem_facets_cover
#print axioms AgentCore.Facet.shell_facets_cover
#print axioms AgentCore.Facet.memory_facets_cover
#print axioms AgentCore.Facet.task_facets_cover
#print axioms AgentCore.Facet.slate_facets_cover
#print axioms AgentCore.Facet.environment_facets_cover
#print axioms AgentCore.Facet.web_facets_cover
#print axioms AgentCore.Facet.mcp_facets_cover
#print axioms AgentCore.Facet.approval_gateway_facets_cover
#print axioms AgentCore.Facet.self_facets_cover
#print axioms AgentCore.Facet.event_facets_cover
#print axioms AgentCore.Facet.subscription_facets_cover
#print axioms AgentCore.Facet.reference_profiles_cover
#print axioms AgentCore.Facet.profile_facets_cover
#print axioms AgentCore.Facet.requested_contributions_representable
#print axioms AgentCore.Facet.gadgets_assembly_covers
#print axioms AgentCore.Facet.seal_assembly_covers
#print axioms AgentCore.Facet.proteus_assembly_covers
#print axioms AgentCore.Facet.reference_assemblies_cover
#print axioms AgentCore.Facet.assembly_profile_contracts_cover

-- SPEC v2 §3 scope-chain authority and bounded-window revocation (Scopes.lean)
#print axioms AgentCore.Scope.self_mem_path
#print axioms AgentCore.Scope.tenant_mem_path
#print axioms AgentCore.Scope.path_preserves_tenant
#print axioms AgentCore.ScopeAuthority.deny_overrides
#print axioms AgentCore.ScopeAuthority.descendant_allow_cannot_rewiden
#print axioms AgentCore.ScopeAuthority.allow_flows_down
#print axioms AgentCore.ScopeAuthority.team_confers_member_access
#print axioms AgentCore.ScopeAuthority.bumpEpoch_epoch
#print axioms AgentCore.ScopeAuthority.bumpEpoch_monotone
#print axioms AgentCore.ScopeAuthority.bumpEpoch_advances
#print axioms AgentCore.ScopeAuthority.bump_stales_stamp
#print axioms AgentCore.ScopeAuthority.stale_stays_stale
#print axioms AgentCore.enforcement_independent_of_memberships

-- SPEC v2 §7.3 approval continuation (Approvals.lean)
#print axioms AgentCore.ApprovalLedger.set_lookup
#print axioms AgentCore.resume_requires_approved_matching_digest
#print axioms AgentCore.digest_mismatch_never_resumes
#print axioms AgentCore.unapproved_never_resumes
#print axioms AgentCore.denied_never_resumes
#print axioms AgentCore.consumed_stable
#print axioms AgentCore.no_resume_when_consumed
#print axioms AgentCore.approval_single_use

-- SPEC v2 §5.2 append-only undo/redo selection (RunGraph.lean)
#print axioms AgentCore.step_preserves_commits
#print axioms AgentCore.append_preserves_lookup
#print axioms AgentCore.append_lookup_self
#print axioms AgentCore.append_ancestor_mono
#print axioms AgentCore.ancestor_mono
#print axioms AgentCore.head_advances
#print axioms AgentCore.undo_appends_and_selects
#print axioms AgentCore.undo_requires_fenced_turn
#print axioms AgentCore.undo_effective_is_ancestor

-- SPEC v2 §7.2 enforcement tiers and §6.1 trust tiers / ingress (Policy.lean)
#print axioms AgentCore.direct_requires_colocation
#print axioms AgentCore.externalSend_always_mediated
#print axioms AgentCore.delegate_always_mediated
#print axioms AgentCore.administer_always_mediated
#print axioms AgentCore.mutate_always_mediated
#print axioms AgentCore.nonsession_execute_mediated
#print axioms AgentCore.self_requires_lease
#print axioms AgentCore.trusted_requires_verification
#print axioms AgentCore.unverified_is_external
#print axioms AgentCore.unverified_never_mints
#print axioms AgentCore.ingress_never_self

-- SPEC v2 §7.3 composed resume path (Composed.lean)
#print axioms AgentCore.composed_resume_guarantees
#print axioms AgentCore.revocation_blocks_composed_resume
#print axioms AgentCore.digest_mismatch_blocks_composed_resume
#print axioms AgentCore.consumed_blocks_composed_resume
#print axioms AgentCore.denied_blocks_composed_resume
