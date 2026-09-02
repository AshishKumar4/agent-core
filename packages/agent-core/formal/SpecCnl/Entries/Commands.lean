import SpecCnl.Parse
import SpecCnl.Grammar

/-!
# Commands vocabulary (§4.3)

One ledger, one label family, three transition families over it, and one lifter. The
`installCommand` label carries a Scope and a whole `CommandDecl`, which is two payload
components, so its lifter scopes a state-relative relation `RE[registry,scope,decl]`
under the install label exactly as the §8.2 resolve lifter does for a reference and a
Tenant.

Two entries read the schema and mapping environments. Those are parameters of
`AgentCore.CommandStep` rather than fields of `AgentCore.CommandRegistry`, so a condition
cannot receive the environment the transition family's step used. Both of them therefore
quantify the environment inside their own denotation and take the transition itself as a
premise, which ties the environment to that transition: `an install checked mapping` and
`a validated operation input` are postconditions about *every* environment admitting the
step in question, and neither matches the label inside its own denotation.
-/

namespace SpecCnl.Entries.Commands

def entries : List LexEntry :=
  [ { id := "every.command.install"
      surface := "every command install"
      category := "TR[AgentCore.CommandRegistry,AgentCore.CommandLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ scope command, label = AgentCore.CommandLabel.installCommand scope command) ∧ " ++
        "∃ schemas mappings, AgentCore.CommandStep schemas mappings before label after" },
    { id := "every.command.invocation"
      surface := "every command invocation"
      category := "TR[AgentCore.CommandRegistry,AgentCore.CommandLabel]"
      denotation :=
        "fun before label after => " ++
        "(∃ scope id arguments, " ++
        "label = AgentCore.CommandLabel.invoke scope id arguments) ∧ " ++
        "∃ schemas mappings, AgentCore.CommandStep schemas mappings before label after" },
    { id := "every.command.step"
      surface := "every command step"
      category := "TR[AgentCore.CommandRegistry,AgentCore.CommandLabel]"
      denotation :=
        "fun before label after => " ++
        "∃ schemas mappings, AgentCore.CommandStep schemas mappings before label after" },
    { id := "for.the.installed.command"
      surface := "for the installed command"
      category :=
        "RE[AgentCore.CommandRegistry,AgentCore.Scope,AgentCore.CommandDecl]" ++
        "\\ST[AgentCore.CommandRegistry,AgentCore.CommandLabel]"
      denotation :=
        "fun cond before label => ∀ scope command, " ++
        "label = AgentCore.CommandLabel.installCommand scope command → " ++
        "cond before scope command" },
    { id := "an.unregistered.surface.name"
      surface := "an unregistered surface name"
      category := "RE[AgentCore.CommandRegistry,AgentCore.Scope,AgentCore.CommandDecl]"
      denotation :=
        "fun registry scope command => " ++
        "∀ surface ∈ AgentCore.CommandDecl.surfaces command, " ++
        "AgentCore.CommandRegistry.surfaces registry scope surface " ++
        "(AgentCore.CommandDecl.name command) = none" },
    { id := "a.nonempty.declared.trust.set"
      surface := "a nonempty declared trust set"
      category := "RE[AgentCore.CommandRegistry,AgentCore.Scope,AgentCore.CommandDecl]"
      denotation :=
        "fun _ _ command => ∀ tiers, " ++
        "AgentCore.CommandDecl.acceptedTrust command = some tiers → tiers ≠ []" },
    { id := "recorded.surface.registrations"
      surface := "recorded surface registrations"
      category := "PR[AgentCore.CommandRegistry]"
      denotation :=
        "fun before after => ∀ scope surface name id, " ++
        "AgentCore.CommandRegistry.surfaces before scope surface name = some id → " ++
        "AgentCore.CommandRegistry.surfaces after scope surface name = some id" },
    { id := "the.derived.route.defaults"
      surface := "the derived route defaults"
      category := "PR[AgentCore.CommandRegistry]"
      denotation :=
        "fun before after => ∀ scope id installed, " ++
        "AgentCore.CommandRegistry.commands before scope id = none → " ++
        "AgentCore.CommandRegistry.commands after scope id = some installed → " ++
        "AgentCore.CommandRoute.authority " ++
        "(AgentCore.InstalledCommand.route installed) = " ++
        "AgentCore.CommandAuthority.initiator " ++
        "(AgentCore.CommandDecl.binding (AgentCore.InstalledCommand.command installed)) ∧ " ++
        "AgentCore.CommandRoute.dedupe (AgentCore.InstalledCommand.route installed) = " ++
        "AgentCore.RouteDedupe.event ∧ " ++
        "AgentCore.CommandRoute.target (AgentCore.InstalledCommand.route installed) = " ++
        "AgentCore.CommandDecl.operation " ++
        "(AgentCore.InstalledCommand.command installed) ∧ " ++
        "AgentCore.CommandRoute.acceptedTrust " ++
        "(AgentCore.InstalledCommand.route installed) ≠ []" },
    { id := "an.exactly.derived.stored.route"
      surface := "an exactly derived stored route"
      category := "PR[AgentCore.CommandRegistry]"
      denotation :=
        "fun before after => ∀ scope id installed, " ++
        "AgentCore.CommandRegistry.commands before scope id = none → " ++
        "AgentCore.CommandRegistry.commands after scope id = some installed → " ++
        "AgentCore.InstalledCommand.route installed = " ++
        "AgentCore.deriveCommandRoute (AgentCore.InstalledCommand.command installed)" },
    { id := "command.declaration"
      surface := "command declaration"
      category := "CN[AgentCore.CommandDecl]"
      denotation := "fun _ => True"
      caveats := [.typeAsCommonNoun] },
    { id := "derives.an.exact.subscription"
      surface := "derives an exact subscription"
      category := "NP[AgentCore.CommandDecl]\\S"
      denotation :=
        "fun command => ∀ tenant target, " ++
        "AgentCore.RoutedSubscription.tenant " ++
        "(AgentCore.deriveSubscription command tenant target) = tenant ∧ " ++
        "AgentCore.RoutedSubscription.target " ++
        "(AgentCore.deriveSubscription command tenant target) = target ∧ " ++
        "AgentCore.RoutedSubscription.enabled " ++
        "(AgentCore.deriveSubscription command tenant target) = true ∧ " ++
        "∀ tier, AgentCore.RoutedSubscription.admits " ++
        "(AgentCore.deriveSubscription command tenant target) tier = true ↔ " ++
        "tier ∈ AgentCore.CommandRoute.acceptedTrust " ++
        "(AgentCore.deriveCommandRoute command)" },
    { id := "an.install.checked.mapping"
      surface := "an install checked mapping"
      category := "PO[AgentCore.CommandRegistry,AgentCore.CommandLabel]"
      denotation :=
        "fun before label after => ∀ schemas mappings, " ++
        "AgentCore.CommandStep schemas mappings before label after → " ++
        "∀ scope id installed, " ++
        "AgentCore.CommandRegistry.commands before scope id = none → " ++
        "AgentCore.CommandRegistry.commands after scope id = some installed → " ++
        "AgentCore.MappingSchemaSafe schemas mappings " ++
        "(AgentCore.InstalledCommand.command installed)" },
    { id := "a.validated.operation.input"
      surface := "a validated operation input"
      category := "PO[AgentCore.CommandRegistry,AgentCore.CommandLabel]"
      denotation :=
        "fun before label after => ∀ schemas mappings, " ++
        "AgentCore.CommandRegistry.InstalledMappingsSafe schemas mappings before → " ++
        "AgentCore.CommandStep schemas mappings before label after → " ++
        "∀ invocation, AgentCore.CommandRegistry.invoked after = " ++
        "invocation :: AgentCore.CommandRegistry.invoked before → " ++
        "∃ installed arguments, " ++
        "AgentCore.CommandRegistry.commands before " ++
        "(AgentCore.CommandInvocation.scope invocation) " ++
        "(AgentCore.CommandInvocation.command invocation) = some installed ∧ " ++
        "schemas (AgentCore.CommandDecl.argumentsSchema " ++
        "(AgentCore.InstalledCommand.command installed)) arguments = true ∧ " ++
        "AgentCore.CommandInvocation.input invocation = " ++
        "mappings (AgentCore.CommandDecl.mapping " ++
        "(AgentCore.InstalledCommand.command installed)) arguments ∧ " ++
        "schemas (AgentCore.CommandDecl.inputSchema " ++
        "(AgentCore.InstalledCommand.command installed)) " ++
        "(AgentCore.CommandInvocation.input invocation) = true" } ]

end SpecCnl.Entries.Commands
