import AgentCore.Substrate.LocalStore
import AgentCore.Substrate.Alarms
import AgentCore.Substrate.Content
import AgentCore.Substrate.Queue
import AgentCore.Substrate.Isolate
import AgentCore.Substrate.Rpc

/-!
# The discharge map: which premise rests on which evidence, and which rests on nothing yet

Each seam module states its laws and proves what follows from them. This module answers the
other question a reviewer asks: *why should anyone believe the premises?* For every entry of
the closed `Premise` vocabulary it names the channel the premise is discharged through, and
it distinguishes six channels because collapsing them is how a ledger starts lying.

* `conformanceAtom` — a §13 atom whose row is `verified` today, discharged by tests in this
  repository. Real evidence.
* `liveLane` — a §13 atom whose `verified` row is discharged by the committed
  deployed-account archive under `artifacts/conformance/live-evidence`, not by a local
  emulation. Real evidence about the real platform, which for a platform premise is the only
  kind that counts.
* `rowBelowVerified` — an atom exists, names its evidence, and is `implemented` or `planned`
  because part of that evidence has not been taken. Partial: the row's own
  `remainingEvidence` says exactly what is missing, so the premise is *cited* but not
  established.
* `declaredNonClaim` — SPEC §14 declares this outside what the formal package claims
  (`NC-TYPESCRIPT-SUBSTRATE-REFINEMENT`, `NC-CLOUDFLARE-BEHAVIOR`,
  `NC-CRYPTOGRAPHIC-COLLISION-RESISTANCE`). Conformance evidence is the only channel there
  will ever be; no theorem here or anywhere else in this package establishes it.
* `declaredAssumption` — one of §14's operational assumptions: trusted monotone time, and
  eventual scheduling under an explicit fairness premise. Assumed by the document, not by
  this library alone.
* `gap` — no atom whose evidence covers it, or an atom that explicitly disclaims every
  citable test it has. Owed, named, and not yet taken.

The exact row ids, test selectors, source symbols, and the prose of each gap live in
`artifacts/substrate-contracts.json`, which `scripts/check-substrate-contracts.mjs`
validates against `artifacts/conformance/*` so a citation cannot rot silently. What lives
here is the structure a reader needs in the same file as the laws: the channel per premise,
and the three theorems that make the map falsifiable.

`open_gaps_are_exactly` is the discriminating witness. Promoting a premise from `gap` to
evidence without updating that list fails to elaborate, which is the only way a discharge
map stays honest under edits.

## What this map says today

Of twenty-one premises, four are open gaps, all four are safety premises, and all four
belong to the `isolate` and `rpc` seams — `opcodes_with_open_gaps_are_exactly` names the
four host calls that inherit them. Of the rest, eight are evidenced today (three of those
from the live deployed-account lane), four are cited by a row that still says what it owes,
two are SPEC §14 non-claims, and three are SPEC §14 operational assumptions — including
both progress premises, since no finite run establishes a liveness statement.

And every host call rests on `Premise.adapterImplementsSeam`, which is a declared
non-claim. That is not a defect to be fixed here: it is SPEC §14 saying that proving
TypeScript refines Lean is not a goal of this package, and this map is where that sentence
becomes visible at every single opcode instead of once in a boundary table.
-/

namespace AgentCore.Substrate

/-- How a premise is discharged. -/
inductive Discharge where
  /-- A §13 atom whose row is `verified` from tests in this repository. -/
  | conformanceAtom
  /-- A §13 atom whose `verified` row is discharged by the committed deployed-account live
  archive rather than a local emulation. -/
  | liveLane
  /-- An atom that cites its evidence but sits below `verified`, with its own
  `remainingEvidence` naming what is missing. -/
  | rowBelowVerified
  /-- A SPEC §14 non-claim: conformance evidence is the only channel, and no theorem in this
  package establishes it. -/
  | declaredNonClaim
  /-- A SPEC §14 operational assumption: trusted monotone time, eventual scheduling. -/
  | declaredAssumption
  /-- Owed and not taken: no atom covers it, or the atom disclaims its own citable tests. -/
  | gap
  deriving DecidableEq, Repr

/-- The closed channel enumeration. -/
def Discharge.all : List Discharge :=
  [.conformanceAtom, .liveLane, .rowBelowVerified, .declaredNonClaim, .declaredAssumption,
   .gap]

/-- Whether a channel is evidence that exists today. `rowBelowVerified` is deliberately not:
a row that names what it still owes is a citation, not a discharge. -/
def Discharge.isEvidence : Discharge → Bool
  | .conformanceAtom => true
  | .liveLane => true
  | .rowBelowVerified => false
  | .declaredNonClaim => false
  | .declaredAssumption => false
  | .gap => false

/-- Whether a channel is an open gap. -/
def Discharge.isGap : Discharge → Bool
  | .gap => true
  | _ => false

/--
The discharge channel of every premise, written out.

Each line is a claim about the repository as it stands, and each is checkable:
`artifacts/substrate-contracts.json` carries the row id, status, and selector behind it,
and `scripts/check-substrate-contracts.mjs` fails when a cited row is absent or its status
no longer matches the channel named here.
-/
def Premise.discharge : Premise → Discharge
  -- SPEC §14: `NC-TYPESCRIPT-SUBSTRATE-REFINEMENT`, `NC-CLOUDFLARE-BEHAVIOR`. Proving that
  -- an adapter refines this model is explicitly not a goal of the formal package.
  | .adapterImplementsSeam => .declaredNonClaim
  -- `C13-OWNERSHIP-ACTOR-CONTRACT` is `verified`: one Actor serializes, recovers,
  -- linearizes, and fences one command stream, against both the memory and the sqlite store.
  | .storeSpanExclusive => .conformanceAtom
  -- `C13-PROTOCOL-ATOMIC-EVIDENCE` is `verified`: a decision that lands without its linked
  -- evidence is refused, on both stores.
  | .storeCommitAtomic => .conformanceAtom
  -- `C13-CLOUDFLARE-STORAGE-LIMIT` is `verified` from the live lane: a row at the declared
  -- blob limit stores and one past it is refused, on the deployed platform.
  | .storeDeclaredBoundAccepted => .liveLane
  -- `C13-OWNERSHIP-ACTOR-CONTRACT` again: the recovery clause of the same verified row.
  | .storeRestartResumesDurableState => .conformanceAtom
  -- `C13-CLOUDFLARE-ALARM-DURABILITY` is `implemented`: the live lane fires an alarm across
  -- a real instance kill and re-fires one whose handler threw, but no scenario yet covers a
  -- start that recovers an alarm the platform stopped re-firing.
  | .alarmDurableAcrossInstanceLoss => .rowBelowVerified
  -- SPEC §14 assumes trusted monotone time. No committed scenario asserts that a firing did
  -- not precede its armed time.
  | .alarmFiresNoEarlierThanArmed => .declaredAssumption
  -- SPEC §14: eventual scheduling holds only under an explicit fairness premise, and no
  -- designated liveness theorem is claimed.
  | .alarmEventuallyFires => .declaredAssumption
  -- `C13-CONTENT-CUSTODY` is `implemented` with retention tests on the memory and sqlite
  -- stores and remaining evidence of its own.
  | .contentRetentionUntilReleased => .rowBelowVerified
  -- SPEC §14: `NC-CRYPTOGRAPHIC-COLLISION-RESISTANCE`.
  | .contentDigestCollisionResistant => .declaredNonClaim
  -- `C13-CONTENT-RESOLUTION` is `verified`: content and retention edges resolve within one
  -- Tenant across an adapter restart.
  | .contentBucketIsTenantOwned => .conformanceAtom
  -- SPEC §14: eventual delivery holds only under an explicit fairness premise. The live
  -- lane's `C13-CLOUDFLARE-QUEUE-DISPOSITION` scenario shows one real redelivery, which
  -- supports the mechanism and cannot establish a universal progress statement.
  | .queueAtLeastOnceDelivery => .declaredAssumption
  -- The same verified live scenario: an acknowledged delivery is not handed back.
  | .queueAckedNeverRedelivered => .liveLane
  -- The same verified live scenario: dead-lettering happens through the real queue.
  | .queueDeadLetterCustody => .liveLane
  -- `C13-CLOUDFLARE-DYNAMIC-NO-EGRESS` is `planned` with no test selectors at all, and its
  -- row explicitly forbids citing the one local test that looks relevant, because that test
  -- asserts the argument the host passed rather than the domain's reach.
  | .isolateNoAmbientEgress => .gap
  -- `C13-CLOUDFLARE-DYNAMIC-COMPUTE-BOUND` is `implemented`, and its own remaining evidence
  -- says nothing yet proves the platform enforces the bound it is handed.
  | .isolateBoundEnforcedByRuntime => .gap
  -- `C13-CLOUDFLARE-DYNAMIC-STORE-CUSTODY` is `implemented`: the host offers no reader, but
  -- isolation is modelled by a fake and the live lane owes the real measurement.
  | .isolatePrivateStoreUnreadable => .rowBelowVerified
  -- `C13-CLOUDFLARE-DYNAMIC-ISOLATE-IDENTITY` is `implemented`: the adapter declares only
  -- the unkeyed load, so the warm path is unreachable, and the live lane owes the
  -- measurement of what a name-keyed warm isolate would hold.
  | .isolateFreshLoadPerSubmission => .rowBelowVerified
  -- No atom states a stub's validity window. The nearest citation is a stub-failure symbol
  -- under `C13-CLOUDFLARE-DEPLOYMENT-CONTINUITY`, which is about durable work surviving a
  -- deployment rather than about when a stub stops answering.
  | .rpcStubLifetimeBoundedByContext => .gap
  -- `C13-ROUTE-DELIVERY-ONCE` and `C13-PROTOCOL-DUPLICATE` are both `verified`: a
  -- redelivery reuses one identity and replays one recorded outcome with exactly one
  -- effect.
  | .rpcRedeliveryPreservesIntent => .conformanceAtom
  -- No atom covers callee-side release on disposal. AGENTS.md states the obligation and no
  -- conformance row observes it.
  | .rpcDisposalReleasesRemoteResources => .gap

/-- Whether a premise is an open gap. -/
def Premise.isGap (premise : Premise) : Bool := premise.discharge.isGap

/-- Every premise's channel is one of the six. -/
theorem Premise.discharge_mem_all (premise : Premise) :
    premise.discharge ∈ Discharge.all := by
  cases premise <;> decide

/--
The open gaps, exactly.

This is the discriminating witness for the whole map: promoting a premise out of `gap`
without editing this list, or letting a premise slide into `gap` without recording it here,
fails to elaborate. A discharge map that cannot be wrong is not evidence of anything.
-/
theorem open_gaps_are_exactly :
    Premise.all.filter Premise.isGap =
      [.isolateNoAmbientEgress, .isolateBoundEnforcedByRuntime,
       .rpcStubLifetimeBoundedByContext, .rpcDisposalReleasesRemoteResources] := by
  decide

/-- Every open gap is a safety premise. Nothing undischarged here is merely about progress,
which is the reason the four gaps are worth naming rather than tolerating. -/
theorem every_gap_is_a_safety_premise (premise : Premise) (open_gap : premise.isGap = true) :
    premise.kind = .safety := by
  cases premise <;> revert open_gap <;> decide

/-- The gaps are confined to two seams: loading code into a `dynamic` domain, and holding a
capability stub. The store, alarm, content, and queue seams have no open gap. -/
theorem gaps_are_confined_to_isolate_and_rpc (premise : Premise)
    (open_gap : premise.isGap = true) :
    premise.seams = [Seam.isolate] ∨ premise.seams = [Seam.rpc] := by
  cases premise <;> revert open_gap <;> decide

/-- Whether an opcode inherits an open gap through its premise closure. -/
def Opcode.hasOpenGap (op : Opcode) : Bool := op.premises.any Premise.isGap

/--
The host calls that rest on an open gap, exactly: loading a `dynamic` isolate, calling into
one, and both stub operations.

A kernel that avoids these four opcodes rests on no undischarged premise beyond the SPEC's
own declared non-claims. A kernel that uses them is relying on evidence that has been named
and not taken, and this theorem is where that is stated rather than implied.
-/
theorem opcodes_with_open_gaps_are_exactly :
    Opcode.all.filter Opcode.hasOpenGap =
      [.isolateLoad, .isolateCall, .rpcCall, .rpcDispose] := by
  decide

/-- Every host call rests on a declared non-claim, because every closure contains the
refinement premise. SPEC §14's boundary is therefore visible at each opcode rather than once
in a table. -/
theorem every_opcode_rests_on_a_declared_nonclaim (op : Opcode) :
    ∃ premise ∈ op.premises, premise.discharge = .declaredNonClaim :=
  ⟨.adapterImplementsSeam, Opcode.refinement_is_always_required op, rfl⟩

/-- No progress premise is a gap: both are declared assumptions of the SPEC, so a safety
result that reached for one would be reaching for something this map already refuses to
call evidence. -/
theorem progress_premises_are_declared_assumptions (premise : Premise)
    (progress : premise.kind = .progress) : premise.discharge = .declaredAssumption := by
  cases premise <;> revert progress <;> decide

end AgentCore.Substrate
