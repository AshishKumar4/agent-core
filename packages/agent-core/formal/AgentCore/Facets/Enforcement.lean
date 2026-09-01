/-
Agent Core SPEC §7.1-§7.2: Operation impact and the enforcement-tier floor.

One Lean module lowers to one TypeScript file. This module owns exactly the concepts
`packages/agent-core/src/facets/contribution.ts` declares above `OperationDescriptor` —
`Impact`, `EnforcementTier`, `enforcementFloor` and `claimHonorsEnforcementFloor` — in the
order they are emitted, so the generated module is substitutable for that surface. The tier
`policies.tiers` may request on top of the floor is applied by `src/definition/policy.ts`
and the mediated-admission conjunction by `src/composition/authority.ts`; neither is modelled
here.

`Impact` deliberately carries no dot-notation method. A Lean inductive that owns behaviour
lowers to a value object, and a value object cannot key `Readonly<Partial<Record<Impact,
EnforcementTier>>>` the way `policies.tiers` needs. §7.1 is also explicit that the host
derives the impact and the host decides the tier: the callee's claim is never authoritative,
so the decision is not the impact's to own.
-/

namespace AgentCore.Facets

/--
Which enforcement tier serves a call (SPEC §7.2). Only `mediated` carries evidence: a
direct call performs its authority, lease, watermark, PathEpochEvidence, and deadline
checks in memory and writes nothing durable, so there is no Invocation for it to name.
-/
inductive EnforcementTier where
  | direct
  | mediated
  deriving DecidableEq, Repr

/--
The impact an Operation declares, and the seam its request crosses (SPEC §4.2, §7.1).
The host derives impact from the seam, never from what the callee claims about itself.
-/
inductive Impact where
  | observe
  | mutate
  | externalSend
  | execute
  | delegate
  | administer
  deriving DecidableEq, Repr

/--
Whether this impact may ever be served directly (SPEC §7.2): `observe` always may;
`execute` only inside a Turn-owned Session; `mutate` only against that Session's own
filesystem; `externalSend`, `delegate`, and `administer` never may.
-/
def admitsDirect (impact : Impact) (turnOwnedSession sessionFilesystemTarget : Bool) : Bool :=
  match impact with
  | .observe => true
  | .mutate => turnOwnedSession && sessionFilesystemTarget
  | .externalSend => false
  | .execute => turnOwnedSession
  | .delegate => false
  | .administer => false

/--
SPEC §7.2's enforcement floor: the weakest tier this impact admits under the given
session conditions. Policy only tightens this floor; it never lowers it.
-/
def enforcementFloor (impact : Impact) (turnOwnedSession sessionFilesystemTarget : Bool) :
    EnforcementTier :=
  if admitsDirect impact turnOwnedSession sessionFilesystemTarget then .direct else .mediated

/--
Whether a claim honors the derived impact's floor under one fixed session condition: the
claim is admissible unless it would be served directly where the derived impact would
have been mediated.
-/
def honorsFloorUnder (claimed derived : Impact) (turnOwnedSession sessionFilesystemTarget : Bool) :
    Bool :=
  !admitsDirect claimed turnOwnedSession sessionFilesystemTarget
    || admitsDirect derived turnOwnedSession sessionFilesystemTarget

/--
SPEC §7.1 (C13-POLICY-IMPACT-BOUNDARY): a callee's own claim may replace the derived
impact only when it never admits a floor (§7.2) the derived impact would have mediated.
Checked under both Turn-owned-Session conditions, because a claim recorded once — at
discovery or install time — has to hold safe at every call site it is later used at.
`sessionFilesystemTarget` is fixed per caller: pass `false` for a seam whose target is
never a Turn-owned Session's own filesystem.
-/
def claimHonorsEnforcementFloor (claimed derived : Impact) (sessionFilesystemTarget : Bool) :
    Bool :=
  honorsFloorUnder claimed derived true sessionFilesystemTarget
    && honorsFloorUnder claimed derived false sessionFilesystemTarget

end AgentCore.Facets
