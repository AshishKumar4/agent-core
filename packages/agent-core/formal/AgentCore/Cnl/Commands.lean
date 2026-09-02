import AgentCore.Commands

/-!
# Consequences of the existing command model the controlled language needs (§4.3)

Three consequences of `AgentCore.Commands` as it stands, each about the record an
installation *adds*. The controlled language quantifies over a transition's two states
and its label, never over an existential the label carries, so "the record this
installation stored" has to be identified by its absence before the step and its presence
after it. That identification is what these theorems supply.

No definition is introduced or changed here. Every proof reads `CommandStep`,
`CommandRegistry.installCommand`, and the theorems already proved beside them.
-/

namespace AgentCore

/-- **An installation stores nothing but its own derived record.** A record present after
an installation and absent before it is exactly the installed declaration paired with its
canonical derived route: installation writes one `(Scope, CommandId)` position, and what
it writes there is the derivation. -/
theorem command_install_stores_only_the_derived_record {schemas mappings}
    {before after : CommandRegistry} {scope : Scope} {command : CommandDecl}
    {candidateScope : Scope} {candidateId : CommandId} {installed : InstalledCommand}
    (step : CommandStep schemas mappings before (.installCommand scope command) after)
    (fresh : before.commands candidateScope candidateId = none)
    (stored : after.commands candidateScope candidateId = some installed) :
    installed = ⟨command, deriveCommandRoute command⟩ := by
  cases step with
  | installCommand _ _ _ _ _ =>
      simp only [CommandRegistry.installCommand] at stored
      split at stored
      · exact (Option.some.inj stored).symm
      · rw [fresh] at stored
        contradiction

/-- **A record an installation adds carries an install-checked mapping.** The install-time
half of §4.3 step 3, stated about the stored record rather than about the incoming
declaration: under the very schema and mapping environment that admitted the
installation, the stored command's mapping sends every argument value its own schema
accepts to a value the target Operation's input schema accepts. -/
theorem command_install_records_install_checked_mapping {schemas mappings}
    {before after : CommandRegistry} {scope : Scope} {command : CommandDecl}
    {candidateScope : Scope} {candidateId : CommandId} {installed : InstalledCommand}
    (step : CommandStep schemas mappings before (.installCommand scope command) after)
    (fresh : before.commands candidateScope candidateId = none)
    (stored : after.commands candidateScope candidateId = some installed) :
    MappingSchemaSafe schemas mappings installed.command := by
  cases command_install_stores_only_the_derived_record step fresh stored
  cases step with
  | installCommand _ _ safe _ _ => exact safe

/-- **An installable command derives a nonempty accepted-trust set.** The §4.3 default set
is nonempty by construction and an explicitly declared one is nonempty by the install
guard, so no installation derives a route that admits no tier at all. -/
theorem derived_route_trust_is_nonempty {schemas mappings}
    {before after : CommandRegistry} {scope : Scope} {command : CommandDecl}
    (step : CommandStep schemas mappings before (.installCommand scope command) after) :
    (deriveCommandRoute command).acceptedTrust ≠ [] := by
  obtain ⟨installed, stored, _, _, _, nonempty⟩ :=
    installed_route_is_initiator_with_event_dedupe step
  obtain ⟨registered, _⟩ := installation_registers_exact_derived_route step
  rw [registered] at stored
  cases Option.some.inj stored
  exact nonempty

end AgentCore
