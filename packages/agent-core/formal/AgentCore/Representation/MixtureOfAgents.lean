import AgentCore.Composed

/-!
Component-shape nonclaim: clean equal-pin binary merge commits can encode aggregation.
No aggregation-quality or external orchestration refinement theorem is claimed.
-/

namespace AgentCore.Representation.MixtureOfAgents

structure ComponentShape where
  run : RunId
  aggregate : CommitId

end AgentCore.Representation.MixtureOfAgents
