/-
The kernel's cross-cutting value types (SPEC §1.4, §8.1, §8.3): the refusal channel, text
measurement and order, identifiers, digests and content addresses, revisions and secret
references, the JSON image, and the record codec layer. Every domain module imports this
one, so there is one definition of each of these and no context carries a second.
-/
import AgentCore.Kernel.Error
import AgentCore.Kernel.Core.Text
import AgentCore.Kernel.Core.Id
import AgentCore.Kernel.Core.Digest
import AgentCore.Kernel.Core.Revision
import AgentCore.Kernel.Core.Json
import AgentCore.Kernel.Core.Codec
