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

inductive ReferencePlatform where
  | gadgets
  | seal
  | proteus
  deriving DecidableEq, Repr

structure ProfileRequirement where
  profile : Profile
  required : List Contribution
  deriving DecidableEq, Repr

structure Assembly where
  platform : ReferencePlatform
  profiles : List Profile
  deriving DecidableEq, Repr

def Provides (facet : Facet) (contribution : Contribution) : Prop :=
  facet.contributions.contains contribution = true

def FacetSetProvides (facets : List Facet) (contribution : Contribution) : Prop :=
  facets.any (fun facet => facet.contributions.contains contribution) = true

def Covers (facets : List Facet) (requirement : ProfileRequirement) : Prop :=
  requirement.required.all (fun contribution =>
    facets.any (fun facet => facet.contributions.contains contribution)) = true

def AssemblyCoversProfiles (assembly : Assembly) (profiles : List Profile) : Prop :=
  profiles.all (fun profile => assembly.profiles.contains profile) = true

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

def facetsFor (_profile : Profile) : List Facet :=
  universalFacets

def gadgetsProfiles : List Profile := [
  .filesystem,
  .slate,
  .approvalGateway,
  .eventProfile,
  .subscriptionProfile,
  .self,
  .web
]

def sealProfiles : List Profile := [
  .filesystem,
  .shell,
  .memory,
  .task,
  .slate,
  .environment,
  .mcp,
  .approvalGateway,
  .eventProfile,
  .subscriptionProfile,
  .self
]

def proteusProfiles : List Profile := [
  .filesystem,
  .shell,
  .memory,
  .task,
  .environment,
  .web,
  .mcp,
  .approvalGateway,
  .eventProfile,
  .subscriptionProfile,
  .self
]

def gadgetsAssembly : Assembly := {
  platform := .gadgets
  profiles := gadgetsProfiles
}

def sealAssembly : Assembly := {
  platform := .seal
  profiles := sealProfiles
}

def proteusAssembly : Assembly := {
  platform := .proteus
  profiles := proteusProfiles
}

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

theorem filesystem_facets_cover :
    Covers (facetsFor .filesystem) (requirementFor .filesystem) := by
  rfl

theorem shell_facets_cover :
    Covers (facetsFor .shell) (requirementFor .shell) := by
  rfl

theorem memory_facets_cover :
    Covers (facetsFor .memory) (requirementFor .memory) := by
  rfl

theorem task_facets_cover :
    Covers (facetsFor .task) (requirementFor .task) := by
  rfl

theorem slate_facets_cover :
    Covers (facetsFor .slate) (requirementFor .slate) := by
  rfl

theorem environment_facets_cover :
    Covers (facetsFor .environment) (requirementFor .environment) := by
  rfl

theorem web_facets_cover :
    Covers (facetsFor .web) (requirementFor .web) := by
  rfl

theorem mcp_facets_cover :
    Covers (facetsFor .mcp) (requirementFor .mcp) := by
  rfl

theorem approval_gateway_facets_cover :
    Covers (facetsFor .approvalGateway) (requirementFor .approvalGateway) := by
  rfl

theorem self_facets_cover :
    Covers (facetsFor .self) (requirementFor .self) := by
  rfl

theorem event_facets_cover :
    Covers (facetsFor .eventProfile) (requirementFor .eventProfile) := by
  rfl

theorem subscription_facets_cover :
    Covers (facetsFor .subscriptionProfile) (requirementFor .subscriptionProfile) := by
  rfl

theorem reference_profiles_cover (profile : Profile) :
    Covers (facetsFor profile) (requirementFor profile) := by
  cases profile <;> rfl

theorem profile_facets_cover (profile : Profile) :
    Covers (facetsFor profile) (requirementFor profile) := by
  exact reference_profiles_cover profile

theorem requested_contributions_representable :
    requestedContributionUniverse.all (fun contribution =>
      universalFacets.any (fun facet =>
        facet.contributions.contains contribution)) = true := by
  rfl

theorem gadgets_assembly_covers :
    AssemblyCoversProfiles gadgetsAssembly gadgetsProfiles := by
  rfl

theorem seal_assembly_covers :
    AssemblyCoversProfiles sealAssembly sealProfiles := by
  rfl

theorem proteus_assembly_covers :
    AssemblyCoversProfiles proteusAssembly proteusProfiles := by
  rfl

theorem reference_assemblies_cover :
    AssemblyCoversProfiles gadgetsAssembly gadgetsProfiles ∧
    AssemblyCoversProfiles sealAssembly sealProfiles ∧
    AssemblyCoversProfiles proteusAssembly proteusProfiles := by
  exact ⟨gadgets_assembly_covers, seal_assembly_covers, proteus_assembly_covers⟩

theorem assembly_profile_contracts_cover (assembly : Assembly) :
    ∀ profile, profile ∈ assembly.profiles → Covers (facetsFor profile) (requirementFor profile) := by
  intro profile _member
  exact profile_facets_cover profile

end AgentCore.Facet
