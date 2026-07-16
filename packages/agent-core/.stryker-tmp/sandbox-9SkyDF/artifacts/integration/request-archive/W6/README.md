# W6 Invocation Mediation Foundation

W6 is implemented from `f558d0ff3f7e93308481ea09c3bf369abbdd19ba` without
changing SPEC, W0-owned tooling, package/root aggregate barrels, or foreign domain
records. W6 owns and exports `src/invocations/index.ts`; W0 owns only package/root
aggregate exposure and the aggregate SQLite barrel.

The source remains intentionally unintegrated across waves until the canonical requests
in this directory are applied by the owning workstream. Runtime dependencies on Run leases,
authority admissions, protection domains, Events, and Run commits are represented by
injected typed codecs and ports. W6 does not persist copies of those records.

The foundation owns:

- canonical `OperationPin` and single/batch `PreparedInvocation` identity;
- Approval revisions and guarded consumption;
- worker-distinct, same-ordinal ItemClaim recovery;
- authority-admission references validated by an injected synchronous port;
- immutable EffectAttempts and Receipt lineage;
- indeterminate reconciliation without resend;
- derived BatchOutcome;
- evidence-substantiated local audit causality;
- memory and SQLite persistence;
- fixed invocation protocol command families.

No aggregate export or conformance claim should be enabled until the integration
request is completed and the same contracts run against the integrated reference
types and Actor composition.
