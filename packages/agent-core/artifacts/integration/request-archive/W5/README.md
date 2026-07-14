# W5 integration requests

W5 implements the Agent/Run/Turn foundation without modifying aggregate barrels,
package exports, the ownership registry, SPEC, or files outside the expressly allowed
Run-specific protocol, SQLite, execution-reference, Agent, test, and request surfaces.
These fragments are requests to the owning integration workstreams, not claims that
the requested aggregate work is already complete.

- `exports.json` lists the internal symbols that may be aggregated only after the
  complete runtime dependency graph is verified.
- `ownership.json` lists the intended single durable owner for every W5 record.
- `ports.json` lists exact cross-domain adapters required to replace W5's typed ports.
- `clarifications.json` lists normative questions that W5 deliberately does not guess.
- `coverage.json` records the raw changed-source counter proof for the W5 hard gate.
- `quality.json` records the detached W0 record-registry fixture timeout blocking the
  aggregate coverage/conformance runner.

The existing public surface remains intentionally unchanged.
