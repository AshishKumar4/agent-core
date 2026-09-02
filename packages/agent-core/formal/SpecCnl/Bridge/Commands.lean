import SpecCnl.Sentences.Commands

/-!
# Hand propositions and bridges for the Commands group (§4.3)

Each `hand_X` is written directly over `AgentCore` from the rule unit. Three bridges are
`Iff.rfl`: the grammar's composition of the reviewed denotations is definitionally the
hand statement. `C13_COMMAND_INVOCATION_CORRELATION` gets a real proof, because its
second clause quantifies over a type-as-common-noun entry whose `True` the hand
proposition does not repeat.
-/

namespace SpecCnl.Bridge

open AgentCore

/-! ## §4.3 `C13-COMMAND-COLLISION` -/

def hand_C13_COMMAND_COLLISION : Prop :=
  (∀ (before : CommandRegistry) (label : CommandLabel) (after : CommandRegistry),
      ((∃ scope command, label = CommandLabel.installCommand scope command) ∧
        ∃ schemas mappings, CommandStep schemas mappings before label after) →
      ∀ scope command, label = CommandLabel.installCommand scope command →
        ∀ surface ∈ command.surfaces, before.surfaces scope surface command.name = none) ∧
    ∀ (before : CommandRegistry) (label : CommandLabel) (after : CommandRegistry),
      (∃ schemas mappings, CommandStep schemas mappings before label after) →
        ∀ scope surface name id, before.surfaces scope surface name = some id →
          after.surfaces scope surface name = some id

theorem bridge_C13_COMMAND_COLLISION :
    Sentences.cnl_C13_COMMAND_COLLISION ↔ hand_C13_COMMAND_COLLISION := Iff.rfl

/-! ## §4.3 `C13-COMMAND-SUBSCRIPTION-DEFAULTS` -/

def hand_C13_COMMAND_SUBSCRIPTION_DEFAULTS : Prop :=
  (∀ (before : CommandRegistry) (label : CommandLabel) (after : CommandRegistry),
      ((∃ scope command, label = CommandLabel.installCommand scope command) ∧
        ∃ schemas mappings, CommandStep schemas mappings before label after) →
      ∀ scope command, label = CommandLabel.installCommand scope command →
        ∀ tiers, command.acceptedTrust = some tiers → tiers ≠ []) ∧
    ∀ (before : CommandRegistry) (label : CommandLabel) (after : CommandRegistry),
      ((∃ scope command, label = CommandLabel.installCommand scope command) ∧
        ∃ schemas mappings, CommandStep schemas mappings before label after) →
      ∀ scope id installed, before.commands scope id = none →
        after.commands scope id = some installed →
          installed.route.authority = CommandAuthority.initiator installed.command.binding ∧
          installed.route.dedupe = RouteDedupe.event ∧
          installed.route.target = installed.command.operation ∧
          installed.route.acceptedTrust ≠ []

theorem bridge_C13_COMMAND_SUBSCRIPTION_DEFAULTS :
    Sentences.cnl_C13_COMMAND_SUBSCRIPTION_DEFAULTS ↔
      hand_C13_COMMAND_SUBSCRIPTION_DEFAULTS := Iff.rfl

/-! ## §4.3 `C13-COMMAND-INVOCATION-CORRELATION` -/

def hand_C13_COMMAND_INVOCATION_CORRELATION : Prop :=
  (∀ (before : CommandRegistry) (label : CommandLabel) (after : CommandRegistry),
      ((∃ scope command, label = CommandLabel.installCommand scope command) ∧
        ∃ schemas mappings, CommandStep schemas mappings before label after) →
      ∀ scope id installed, before.commands scope id = none →
        after.commands scope id = some installed →
          installed.route = deriveCommandRoute installed.command) ∧
    ∀ (command : CommandDecl) (tenant : TenantId) (target : InvocationId),
      (deriveSubscription command tenant target).tenant = tenant ∧
      (deriveSubscription command tenant target).target = target ∧
      (deriveSubscription command tenant target).enabled = true ∧
      ∀ tier, (deriveSubscription command tenant target).admits tier = true ↔
        tier ∈ (deriveCommandRoute command).acceptedTrust

theorem bridge_C13_COMMAND_INVOCATION_CORRELATION :
    Sentences.cnl_C13_COMMAND_INVOCATION_CORRELATION ↔
      hand_C13_COMMAND_INVOCATION_CORRELATION := by
  unfold Sentences.cnl_C13_COMMAND_INVOCATION_CORRELATION
    hand_C13_COMMAND_INVOCATION_CORRELATION sAnd qEvery
  exact ⟨fun claim => ⟨claim.1, fun command => claim.2 command trivial⟩,
    fun claim => ⟨claim.1, fun command _ => claim.2 command⟩⟩

/-! ## §4.3 `C13-COMMAND-ARGUMENT-BINDING`, `C13-COMMAND-INSTALL-MAPPING` -/

def hand_C13_COMMAND_ARGUMENT_BINDING : Prop :=
  (∀ (before : CommandRegistry) (label : CommandLabel) (after : CommandRegistry),
      ((∃ scope command, label = CommandLabel.installCommand scope command) ∧
        ∃ schemas mappings, CommandStep schemas mappings before label after) →
      ∀ schemas mappings, CommandStep schemas mappings before label after →
        ∀ scope id installed, before.commands scope id = none →
          after.commands scope id = some installed →
            MappingSchemaSafe schemas mappings installed.command) ∧
    ∀ (before : CommandRegistry) (label : CommandLabel) (after : CommandRegistry),
      ((∃ scope id arguments, label = CommandLabel.invoke scope id arguments) ∧
        ∃ schemas mappings, CommandStep schemas mappings before label after) →
      ∀ schemas mappings, before.InstalledMappingsSafe schemas mappings →
        CommandStep schemas mappings before label after →
        ∀ invocation, after.invoked = invocation :: before.invoked →
          ∃ installed arguments,
            before.commands invocation.scope invocation.command = some installed ∧
            schemas installed.command.argumentsSchema arguments = true ∧
            invocation.input = mappings installed.command.mapping arguments ∧
            schemas installed.command.inputSchema invocation.input = true

theorem bridge_C13_COMMAND_ARGUMENT_BINDING :
    Sentences.cnl_C13_COMMAND_ARGUMENT_BINDING ↔
      hand_C13_COMMAND_ARGUMENT_BINDING := Iff.rfl

end SpecCnl.Bridge
