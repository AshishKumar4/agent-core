# Substrate contracts

`formal/AgentCore/Substrate` models every substrate seam a verified kernel calls. This
document is the operator-facing half: what each contract owes, what evidence discharges it
today, what is still owed, and where the adapter code disagrees with a law.

Build it with `lake build AgentCore.Substrate` from `formal/`. Nothing in `AgentCore.lean`
imports the tree, so no designated theorem can depend on a substrate premise, and the
target stands alone: the modules import Lean core only, never the model.

The machine-checkable form of everything below is
`artifacts/substrate-contracts.json`, validated by
`node scripts/check-substrate-contracts.mjs`. That check fails when a cited row disappears,
changes status, is paraphrased, when a premise's channel disagrees with Lean's own
`Premise.discharge` table, when a gap stops saying what it owes, or when an opcode exists in
one file and not the other.

## The shape

| Piece             | What it is                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `<Seam>Op`        | the closed request vocabulary, one constructor per wire tail                                           |
| `<Seam>Reply`     | the closed reply vocabulary — a host failure is a `refused` value, not a throw                         |
| `<Seam>Effect σ`  | the interface: function fields `args → σ → Reply × σ`, threaded as an explicit parameter               |
| `<Seam>Laws`      | the equations a kernel relies on, each a named field of a `Prop` structure                             |
| `<Seam>View σ`    | model observers a law needs and an opcode does not provide; erased at lowering                         |
| `Opcode`          | the closed host-call set, with `Opcode.wire` giving `host.<seam>.<op>` and `Opcode.ofWire` decoding it |
| `Premise`         | the closed vocabulary of facts a law cannot state, each with a discharge channel                       |
| `Opcode.premises` | the premise closure one host call rests on                                                             |

Two rules make this a contract rather than a description. **A law is a premise a caller
supplies**: a theorem that needs the store to read back what it wrote says so in its binder
list, so no conclusion hides an assumption. **A premise is never an axiom**: there is no
`axiom`, `opaque`, `partial`, `unsafe`, `sorry`, or `native_decide` anywhere in the tree,
and the axiom union over all 1,537 declarations is `{propext, Quot.sound}` — inside the
standard three, and `Classical.choice` is unused because no proof here needs it.

## Wire names

| Seam    | Opcodes                                                                                  |
| ------- | ---------------------------------------------------------------------------------------- |
| store   | `host.store.get` `host.store.put` `host.store.delete` `host.store.list` `host.store.txn` |
| alarm   | `host.alarm.set` `host.alarm.get` `host.alarm.delete`                                    |
| content | `host.content.put` `host.content.get` `host.content.head` `host.content.range`           |
| queue   | `host.queue.send` `host.queue.ack` `host.queue.retry`                                    |
| isolate | `host.isolate.load` `host.isolate.call`                                                  |
| rpc     | `host.rpc.call` `host.rpc.dispose`                                                       |

The absences are deliberate and two of them are provable: `Opcode.isolate_seam_has_no_store_access`
says the isolate seam offers only a load and a call, which is `C13-CLOUDFLARE-DYNAMIC-STORE-CUSTODY`
at the interface — a `dynamic` domain's private store is not merely unread by policy, there
is no opcode that could read it. `Opcode.content_seam_has_no_deletion` says the same for
content: collection is Tenant retention policy over unowned content, never a kernel call.
A delivery arriving is not an opcode either, because the kernel does not call it.

## What each contract proves

**Store** (`LocalStore.lean`). A transaction carries a _write plan_, not a callback: a
higher-order host call is nothing a registry row can spell, and the §8.5 span reads its
gate, computes, then commits a finite write set. Fencing is not a store primitive — §10.4
is explicit that all fencing is the application-level lease epoch — so `guardedCommit` is
the kernel's construction over `read_is_pure` plus `Premise.storeSpanExclusive`, and its
theorems are: a stale fence leaves the state untouched, a live fence applies exactly the
plan, an over-limit plan never mutates, and `guarded_commit_is_all_or_nothing` — there is no
third outcome, so a recovery path has two states to consider rather than a partial write.
`listing_is_duplicate_free` turns the sorted-iteration law into the property a kernel fold
needs.

**Alarm** (`Alarms.lean`). The single physical slot is one law: `set_arms` constrains the
reading after a `set` from _any_ prior state, so two simultaneously armed due times are
unrepresentable. Everything §10.4 says about arbitration is then proved over `ClaimTable`
rather than assumed: the slot tracks the earliest live claim and points at a claim that
exists, it is at or before every live claim, recording or releasing one owner leaves every
other owner's due time exactly where it was, another owner's survival keeps the slot armed
no later than that owner needs (`release_keeps_other_owners_wakeup`), teardown happens only
when the table empties, and rebuilding from the table is idempotent so a restart may repeat
it. `acknowledge_is_fenced` is `C13-CLOUDFLARE-RECONCILIATION-FENCE`: an entry rescheduled
underneath a running sweep survives it. `defer_is_in_the_future` is
`C13-CLOUDFLARE-RECONCILIATION-RETRY`: a failed sweep re-arms one delay out rather than at a
past schedule that would refire immediately and spin.

**Content** (`Content.lean`). `put_is_content_addressed` and `get_verifies` together make a
ref an assertion about content rather than a key someone chose — a store that would serve
the wrong object must refuse instead. What they do not give is that a ref names _one_
object; that is `Premise.contentDigestCollisionResistant`, and
`content_read_is_determined` takes digest injectivity as an explicit parameter so the
conclusion that rests on the collision assumption names it. Ranges refuse rather than clamp,
because a short read that looks successful is how a caller digests a prefix.
`range_inside_stat_reads_bytes` is the useful direction: check `head`, then a range inside
the reported size cannot refuse.

**At-least-once** (`AtLeastOnce.lean`). Exactly-once is the kernel's construction, not the
platform's promise: `Inbox.accept` applies a delivery only under an unseen key, and
`batch_replay_is_a_noop` says replaying a whole batch — any number of times — moves nothing.
Duplication is therefore an adversary power these results survive rather than a premise
anything needs, which is why no `Premise` entry claims at-most-once delivery.

**Queue** (`Queue.lean`). Three obligations from one §10.4 paragraph, kept apart: the
transport's (`QueueLaws` — an acked delivery leaves the in-flight set, a retried one returns
with its attempt counted, one delivery's disposition never moves another's, and the retry
bound hands custody to the dead-letter policy rather than dropping or looping), the
consumer's (`settle` decides each message alone; `undecodable_is_retried_never_acknowledged`
— acknowledging destroys the message, so an unidentifiable body is retried and never acked),
and the kernel's (the inbox above).

**Isolate** (`Isolate.lean`). An unbounded load is refused _by a law_, because §10.2's rule
that a host which cannot bound a submission must refuse it is a property of the seam the
host offers. `loads_never_share_an_isolate` and
`sibling_load_cannot_reach_another_delegation` are `C13-CLOUDFLARE-DYNAMIC-ISOLATE-IDENTITY`'s
consequence: no submission ever observes another's capability set, including the case the
rule exists for, where two submissions' code digests are equal and their delegations are
not.

**Rpc** (`Rpc.lean`). `stepCall` is §10.2's single-step scope as code — call, then dispose —
and `step_closes_its_stub` proves nothing live survives a step, so a kernel built this way
cannot carry a stub across steps even by accident. `pipelined_step_returns_the_resolved_reply`
says pipelining is observationally free, which is what makes AGENTS.md's "use promise
pipelining whenever possible" a safe instruction rather than a risky one.

## The discharge map

Twenty-one premises. Eight are evidenced today, three of those by the committed
deployed-account lane; four are cited by a row that still names what it owes; two are SPEC
§14 non-claims and three are §14 operational assumptions; **four are open gaps**.

| Premise                              | Channel             | Evidence or what is owed                                                                                                                                                                                        |
| ------------------------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapterImplementsSeam`              | declared non-claim  | §14 `NC-TYPESCRIPT-SUBSTRATE-REFINEMENT`, `NC-CLOUDFLARE-BEHAVIOR`                                                                                                                                              |
| `storeSpanExclusive`                 | conformance atom    | `C13-OWNERSHIP-ACTOR-CONTRACT` verified, memory and sqlite                                                                                                                                                      |
| `storeCommitAtomic`                  | conformance atom    | `C13-PROTOCOL-ATOMIC-EVIDENCE` verified, memory and sqlite                                                                                                                                                      |
| `storeDeclaredBoundAccepted`         | live lane           | `C13-CLOUDFLARE-STORAGE-LIMIT` verified on the deployed platform                                                                                                                                                |
| `storeRestartResumesDurableState`    | conformance atom    | `C13-OWNERSHIP-ACTOR-CONTRACT` recovery clause                                                                                                                                                                  |
| `alarmDurableAcrossInstanceLoss`     | row below verified  | `C13-CLOUDFLARE-ALARM-DURABILITY` implemented; owes a start that recovers an alarm the platform stopped re-firing                                                                                               |
| `alarmFiresNoEarlierThanArmed`       | declared assumption | §14 trusted monotone time; no scenario asserts a firing did not precede its arming                                                                                                                              |
| `alarmEventuallyFires`               | declared assumption | §14 fairness; no designated liveness theorem                                                                                                                                                                    |
| `contentRetentionUntilReleased`      | row below verified  | `C13-CONTENT-CUSTODY` implemented with five remaining entries                                                                                                                                                   |
| `contentDigestCollisionResistant`    | declared non-claim  | §14 `NC-CRYPTOGRAPHIC-COLLISION-RESISTANCE`                                                                                                                                                                     |
| `contentBucketIsTenantOwned`         | conformance atom    | `C13-CONTENT-RESOLUTION` verified                                                                                                                                                                               |
| `queueAtLeastOnceDelivery`           | declared assumption | §14 fairness; the live redelivery supports the mechanism and cannot establish liveness                                                                                                                          |
| `queueAckedNeverRedelivered`         | live lane           | `C13-CLOUDFLARE-QUEUE-DISPOSITION` verified through a real queue                                                                                                                                                |
| `queueDeadLetterCustody`             | live lane           | same scenario, dead-letter half                                                                                                                                                                                 |
| `isolateNoAmbientEgress`             | **gap**             | `C13-CLOUDFLARE-DYNAMIC-NO-EGRESS` is planned with no selectors; owes adversarial code in a real isolate of each backing failing an unbound fetch _and_ an unbound connect while a passed Binding still answers |
| `isolateBoundEnforcedByRuntime`      | **gap**             | `C13-CLOUDFLARE-DYNAMIC-COMPUTE-BOUND`: nothing yet proves the platform enforces the bound; owes a cpuMs spin and a subrequest overrun                                                                          |
| `isolatePrivateStoreUnreadable`      | row below verified  | `C13-CLOUDFLARE-DYNAMIC-STORE-CUSTODY` implemented against a fake; owes the real facet measurement                                                                                                              |
| `isolateFreshLoadPerSubmission`      | row below verified  | `C13-CLOUDFLARE-DYNAMIC-ISOLATE-IDENTITY` implemented; owes the name-keyed warm-path measurement                                                                                                                |
| `rpcStubLifetimeBoundedByContext`    | **gap**             | no atom states a stub's validity window                                                                                                                                                                         |
| `rpcRedeliveryPreservesIntent`       | conformance atom    | `C13-ROUTE-DELIVERY-ONCE` and `C13-PROTOCOL-DUPLICATE`, both verified                                                                                                                                           |
| `rpcDisposalReleasesRemoteResources` | **gap**             | no atom observes callee-side release on disposal                                                                                                                                                                |

Three theorems make this map falsifiable rather than decorative. `open_gaps_are_exactly`
lists the four gaps, so promoting one without editing the list fails to elaborate.
`every_gap_is_a_safety_premise` says nothing undischarged is merely about progress.
`opcodes_with_open_gaps_are_exactly` names the four host calls that inherit a gap —
`host.isolate.load`, `host.isolate.call`, `host.rpc.call`, `host.rpc.dispose` — so a kernel
that avoids them rests on no undischarged premise beyond the SPEC's own non-claims.

## Findings against the adapter code

Every law above was checked against `packages/agent-core/src` and
`packages/agent-core-cloudflare/src`. Eight divergences, none of them a law the code
silently breaks; full detail with line numbers is in
`artifacts/substrate-contracts.json#findings`.

**SC-F1 (store, scope).** `C13-CLOUDFLARE-STORAGE-LIMIT` requires refusing an over-limit
payload _before_ opening a transaction. `requireStorableBlob` does exactly that for blob
payloads. `requireExecutableStatement` — the statement-length and bound-parameter check —
runs inside `execute`, hence inside `storage.transactionSync` for a transactional write. The
observable rule survives because a throw inside `transactionSync` rolls back, so the durable
log is unchanged, but the refusal is a rollback rather than a pre-check. The law states the
observable consequence, which both mechanisms satisfy.

**SC-F2 (store, shape).** `ActorLocalStore` is a transaction-scope seam — `transaction`,
`read`, `activateActor`, and one record-set declaration blob pair — not a key/value store,
and nothing anywhere offers a prefix listing. The key/value projection behind
`host.store.get/put/delete/list/txn` has no implementation in either package today; every
durable read and write is SQL through a transaction handle. `LocalStoreLaws` is therefore the
contract an adapter for this seam owes, deterministic sorted-key iteration included.

**SC-F3 (content, gap).** §8.2 declares `get(ref, range?)` and `stat(ref)`. The R2 object
repository implements neither: whole-object put and get, digest verified, bounded at 32 MiB,
and no class in `packages/agent-core-cloudflare` extends `ContentStore`. Range and stat exist
only on the memory and sqlite stores, where a range is a slice of an already-buffered object.
`C13-CONTENT-RESOLUTION` is verified against the sqlite store, so no verified row covers R2
content resolution.

**SC-F4 (queue, model corrected).** The first draft of this library made an undecodable body
produce no host call at all. §10.4 and `AtLeastOnceQueueAdapter` both _retry_ it —
acknowledging destroys the message, and leaving it undispositioned loses the decision — so
`Disposition.hostCall` retries and `only_acceptance_acknowledges` holds. The cross-check
against the adapter is what caught it.

**SC-F5 (isolate, scope).** `C13-CLOUDFLARE-DYNAMIC-STORE-LIFECYCLE` — stopping preserves a
domain's store, destroying releases it, a withdrawal destroys rather than stops — is not
expressible in a kernel opcode set of load and call. Those verbs are
`DurableObjectFacetHost`'s `open`/`suspend`/`retire`, and that row itself records that no
withdrawal path calls `retire` yet.

**SC-F6 (rpc, gap).** AGENTS.md requires promise pipelining wherever possible and requires
stub disposal. No conformance atom observes either. `RpcLaws.pipelining_is_transparent` and
`RpcLaws.dispose_releases` state them, and two premises carry the missing evidence.

**SC-F7 (alarm, observation).** `ClaimedAlarmStorage.getAlarm` reports an owner's claim only
while the physical alarm is non-null, so a claim table with a torn-down slot reads as
unarmed rather than armed-but-unsynchronized. The Lean model keeps arbitration over the claim
table and models `get` as the physical slot, which is why the two agree: the claim table is
the repair source in both.

**SC-F8 (four seams, gap).** Four law sets have no satisfiability witness yet — see the
next section.

## Satisfiability

A law set nobody can satisfy makes every theorem resting on it vacuously true, so
`Witness.lean` carries reference implementations and proves they satisfy their seam's laws
in full. `AlarmLaws` and `ContentLaws` are witnessed — content's fifteen laws include
addressing, read verification, both bound directions, stat faithfulness in both directions,
and the range algebra, so a witness for it is real evidence that the set is consistent.

`LocalStoreLaws`, `QueueLaws`, `IsolateLaws`, and `RpcLaws` are **owed**, recorded with the
exact proof each still needs rather than closed with a degenerate witness. `LocalStoreLaws`
needs `list_sorted` and `list_complete` together, so it needs a strict total order on
`ByteArray` keys: a lexicographic `keyLe` with transitivity and totality (which
`List.pairwise_mergeSort` then consumes), deduplication, and `byteRank` injectivity, the
last reachable through `ByteArray.ext`, `Array.toList_inj`, and `UInt8.toNat_inj`. The
other three are stated against a `View`, so a witness must build the observers too,
including a fresh-identifier scheme that is fresh in _every_ state of the carrier type
rather than only in reachable ones.

The distinction matters because the cheap version is worthless: a loader that refuses every
load satisfies `IsolateLaws` with every interesting law vacuous. `check-substrate-contracts`
enforces the honest version — a claimed witness must exist in `Witness.lean`, and an owed
one must say what it owes.

## Claim boundary

This library designates no theorem, owns no `AC-*` requirement, adds no `ASM-*` entry, and
appears in no line of `AgentCore/Axioms.lean`. Under `artifacts/traceability.yaml`'s
vocabulary every declaration is a `component-shape-nonclaim`: Lean holds the shape and the
ledger claims nothing for it until a maintainer reviews it into the normative surface, which
is a Tier D change under `AGENT_OPERATING_DOCTRINE.md` §2. Nothing here asks for that
promotion.

It also claims nothing about any deployment. SPEC §14 places Durable Object transactions and
storage/RPC failure semantics outside what the formal package models, and this library does
not move that boundary — `Premise.adapterImplementsSeam` _is_ that boundary, named at every
single opcode instead of once in a table.
