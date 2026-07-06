namespace AgentCore.Facet

/-!
This module models the expressiveness of a single universal runtime
abstraction, `Facet`. It proves only representational coverage:
the declared reference Facet profiles in the specification can be covered
by composing values of this one abstraction.

It does not prove concrete product conformance, provider correctness,
runtime safety, prompt safety, or implementation refinement.
-/

inductive Contribution where
  | authorityCapability
  | promptContext
  | modelOperations
  | uiSurface
  | childFacetComposition
  | eventEmission
  | subscriptionRouting
  | lifecycle
  | invocationApproval
  | environmentSession
  | fileSystem
  | commandExecution
  | slateApplication
  | memoryRecall
  | taskWork
  | mcpIntegration
  | approvalGatewayResource
  | webAccess
  | selfControl
  | childRunDelegation
  | blueprintTemplate
  | scheduleEvent
  | outputArtifact
  | modelProvider
  deriving DecidableEq, Repr

structure Facet where
  name : String
  contributions : List Contribution
  deriving DecidableEq, Repr

inductive Profile where
  | filesystem
  | shell
  | memory
  | task
  | slate
  | environment
  | web
  | mcp
  | approvalGateway
  | self
  | eventProfile
  | subscriptionProfile
  deriving DecidableEq, Repr

structure ProfileRequirement where
  profile : Profile
  required : List Contribution
  deriving DecidableEq, Repr

def Provides (facet : Facet) (contribution : Contribution) : Prop :=
  facet.contributions.contains contribution = true

def FacetSetProvides (facets : List Facet) (contribution : Contribution) : Prop :=
  facets.any (fun facet => facet.contributions.contains contribution) = true

def Covers (facets : List Facet) (requirement : ProfileRequirement) : Prop :=
  requirement.required.all (fun contribution =>
    facets.any (fun facet => facet.contributions.contains contribution)) = true

def policyFacet : Facet := {
  name := "policy"
  contributions := [
    .authorityCapability,
    .invocationApproval,
    .lifecycle,
    .modelProvider
  ]
}

def promptFacet : Facet := {
  name := "prompt"
  contributions := [
    .promptContext,
    .modelOperations,
    .eventEmission,
    .subscriptionRouting
  ]
}

def runtimeFacet : Facet := {
  name := "runtime"
  contributions := [
    .environmentSession,
    .fileSystem,
    .commandExecution
  ]
}

def integrationFacet : Facet := {
  name := "integration"
  contributions := [
    .mcpIntegration,
    .approvalGatewayResource,
    .webAccess
  ]
}

def workspaceFacet : Facet := {
  name := "workspace"
  contributions := [
    .memoryRecall,
    .taskWork,
    .outputArtifact
  ]
}

def slateFacet : Facet := {
  name := "slate"
  contributions := [
    .slateApplication,
    .uiSurface,
    .blueprintTemplate
  ]
}

def orchestrationFacet : Facet := {
  name := "orchestration"
  contributions := [
    .selfControl,
    .childRunDelegation,
    .childFacetComposition,
    .scheduleEvent
  ]
}

def universalFacets : List Facet := [
  policyFacet,
  promptFacet,
  runtimeFacet,
  integrationFacet,
  workspaceFacet,
  slateFacet,
  orchestrationFacet
]

def filesystemRequirement : ProfileRequirement := {
  profile := .filesystem
  required := [
    .authorityCapability,
    .modelOperations,
    .lifecycle,
    .fileSystem
  ]
}

def shellRequirement : ProfileRequirement := {
  profile := .shell
  required := [
    .authorityCapability,
    .modelOperations,
    .lifecycle,
    .fileSystem,
    .commandExecution
  ]
}

def memoryRequirement : ProfileRequirement := {
  profile := .memory
  required := [
    .promptContext,
    .modelOperations,
    .uiSurface,
    .lifecycle,
    .memoryRecall
  ]
}

def taskRequirement : ProfileRequirement := {
  profile := .task
  required := [
    .modelOperations,
    .uiSurface,
    .lifecycle,
    .taskWork,
    .scheduleEvent
  ]
}

def slateRequirement : ProfileRequirement := {
  profile := .slate
  required := [
    .authorityCapability,
    .modelOperations,
    .uiSurface,
    .lifecycle,
    .slateApplication,
    .blueprintTemplate,
    .outputArtifact
  ]
}

def environmentRequirement : ProfileRequirement := {
  profile := .environment
  required := [
    .authorityCapability,
    .childFacetComposition,
    .lifecycle,
    .environmentSession,
    .fileSystem,
    .commandExecution
  ]
}

def webRequirement : ProfileRequirement := {
  profile := .web
  required := [
    .authorityCapability,
    .modelOperations,
    .lifecycle,
    .webAccess
  ]
}

def mcpRequirement : ProfileRequirement := {
  profile := .mcp
  required := [
    .promptContext,
    .modelOperations,
    .lifecycle,
    .mcpIntegration
  ]
}

def approvalGatewayRequirement : ProfileRequirement := {
  profile := .approvalGateway
  required := [
    .authorityCapability,
    .uiSurface,
    .lifecycle,
    .invocationApproval,
    .approvalGatewayResource
  ]
}

def selfRequirement : ProfileRequirement := {
  profile := .self
  required := [
    .modelOperations,
    .childFacetComposition,
    .lifecycle,
    .selfControl,
    .childRunDelegation
  ]
}

def eventRequirement : ProfileRequirement := {
  profile := .eventProfile
  required := [
    .authorityCapability,
    .eventEmission,
    .lifecycle
  ]
}

def subscriptionRequirement : ProfileRequirement := {
  profile := .subscriptionProfile
  required := [
    .authorityCapability,
    .subscriptionRouting,
    .modelOperations,
    .lifecycle
  ]
}

def requirementFor : Profile → ProfileRequirement
  | .filesystem => filesystemRequirement
  | .shell => shellRequirement
  | .memory => memoryRequirement
  | .task => taskRequirement
  | .slate => slateRequirement
  | .environment => environmentRequirement
  | .web => webRequirement
  | .mcp => mcpRequirement
  | .approvalGateway => approvalGatewayRequirement
  | .self => selfRequirement
  | .eventProfile => eventRequirement
  | .subscriptionProfile => subscriptionRequirement

/-- The facets selected to realize a profile. This is a genuine per-profile
    function: each profile names the subset of the fixed facet vocabulary that
    supplies its required contributions. The coverage theorems below are therefore
    statements about a real selection, not about a constant that ignores its input. -/
def facetsFor : Profile → List Facet
  | .filesystem => [policyFacet, promptFacet, runtimeFacet]
  | .shell => [policyFacet, promptFacet, runtimeFacet]
  | .memory => [policyFacet, promptFacet, slateFacet, workspaceFacet]
  | .task => [policyFacet, promptFacet, slateFacet, workspaceFacet, orchestrationFacet]
  | .slate => [policyFacet, promptFacet, slateFacet, workspaceFacet]
  | .environment => [policyFacet, runtimeFacet, orchestrationFacet]
  | .web => [policyFacet, promptFacet, integrationFacet]
  | .mcp => [policyFacet, promptFacet, integrationFacet]
  | .approvalGateway => [policyFacet, slateFacet, integrationFacet]
  | .self => [policyFacet, promptFacet, orchestrationFacet]
  | .eventProfile => [policyFacet, promptFacet]
  | .subscriptionProfile => [policyFacet, promptFacet]

def requestedContributionUniverse : List Contribution := [
  .authorityCapability,
  .promptContext,
  .modelOperations,
  .uiSurface,
  .childFacetComposition,
  .eventEmission,
  .subscriptionRouting,
  .lifecycle,
  .invocationApproval,
  .environmentSession,
  .fileSystem,
  .commandExecution,
  .slateApplication,
  .memoryRecall,
  .taskWork,
  .mcpIntegration,
  .approvalGatewayResource,
  .webAccess,
  .selfControl,
  .childRunDelegation,
  .blueprintTemplate,
  .scheduleEvent,
  .outputArtifact,
  .modelProvider
]

private theorem policy_provides_authority :
    Provides policyFacet .authorityCapability := by simp [Provides, policyFacet]

private theorem policy_provides_invocation_approval :
    Provides policyFacet .invocationApproval := by simp [Provides, policyFacet]

private theorem policy_provides_lifecycle :
    Provides policyFacet .lifecycle := by simp [Provides, policyFacet]

private theorem policy_provides_model_provider :
    Provides policyFacet .modelProvider := by simp [Provides, policyFacet]

private theorem prompt_provides_prompt :
    Provides promptFacet .promptContext := by simp [Provides, promptFacet]

private theorem prompt_provides_operations :
    Provides promptFacet .modelOperations := by simp [Provides, promptFacet]

private theorem prompt_provides_event_emission :
    Provides promptFacet .eventEmission := by simp [Provides, promptFacet]

private theorem prompt_provides_subscription_routing :
    Provides promptFacet .subscriptionRouting := by simp [Provides, promptFacet]

private theorem runtime_provides_environment :
    Provides runtimeFacet .environmentSession := by simp [Provides, runtimeFacet]

private theorem runtime_provides_files :
    Provides runtimeFacet .fileSystem := by simp [Provides, runtimeFacet]

private theorem runtime_provides_commands :
    Provides runtimeFacet .commandExecution := by simp [Provides, runtimeFacet]

private theorem integration_provides_mcp :
    Provides integrationFacet .mcpIntegration := by simp [Provides, integrationFacet]

private theorem integration_provides_approval_gateway :
    Provides integrationFacet .approvalGatewayResource := by simp [Provides, integrationFacet]

private theorem integration_provides_web :
    Provides integrationFacet .webAccess := by simp [Provides, integrationFacet]

private theorem workspace_provides_memory :
    Provides workspaceFacet .memoryRecall := by simp [Provides, workspaceFacet]

private theorem workspace_provides_tasks :
    Provides workspaceFacet .taskWork := by simp [Provides, workspaceFacet]

private theorem workspace_provides_outputs :
    Provides workspaceFacet .outputArtifact := by simp [Provides, workspaceFacet]

private theorem slate_provides_slate :
    Provides slateFacet .slateApplication := by simp [Provides, slateFacet]

private theorem slate_provides_ui :
    Provides slateFacet .uiSurface := by simp [Provides, slateFacet]

private theorem slate_provides_blueprint :
    Provides slateFacet .blueprintTemplate := by simp [Provides, slateFacet]

private theorem orchestration_provides_self :
    Provides orchestrationFacet .selfControl := by simp [Provides, orchestrationFacet]

private theorem orchestration_provides_child_runs :
    Provides orchestrationFacet .childRunDelegation := by simp [Provides, orchestrationFacet]

private theorem orchestration_provides_child_facets :
    Provides orchestrationFacet .childFacetComposition := by simp [Provides, orchestrationFacet]

private theorem orchestration_provides_schedule :
    Provides orchestrationFacet .scheduleEvent := by simp [Provides, orchestrationFacet]

theorem universal_facets_cover_contribution {contribution : Contribution}
    (member : contribution ∈ requestedContributionUniverse) :
    FacetSetProvides universalFacets contribution := by
  cases contribution <;>
    simp [requestedContributionUniverse, FacetSetProvides, universalFacets,
      policyFacet, promptFacet, runtimeFacet, integrationFacet,
      workspaceFacet, slateFacet, orchestrationFacet] at member ⊢

/-- Every core profile's selected facets supply all of that profile's required
    contributions. Because `facetsFor` is a genuine per-profile selection, this is a
    real (non-vacuous) representability witness: the fixed facet vocabulary is
    expressive enough to realize each declared profile. It is a witness, not a safety
    theorem — it says nothing about runtime behavior or product conformance. -/
theorem profile_facets_cover (profile : Profile) :
    Covers (facetsFor profile) (requirementFor profile) := by
  cases profile <;> rfl

theorem filesystem_facets_cover :
    Covers (facetsFor .filesystem) (requirementFor .filesystem) := profile_facets_cover _

theorem approval_gateway_facets_cover :
    Covers (facetsFor .approvalGateway) (requirementFor .approvalGateway) := profile_facets_cover _

theorem self_facets_cover :
    Covers (facetsFor .self) (requirementFor .self) := profile_facets_cover _

theorem requested_contributions_representable :
    requestedContributionUniverse.all (fun contribution =>
      universalFacets.any (fun facet =>
        facet.contributions.contains contribution)) = true := by
  rfl

end AgentCore.Facet
