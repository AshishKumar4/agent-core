import SpecCnl.Unit
import SpecCnl.Units.Auth
import SpecCnl.Units.Claims
import SpecCnl.Units.Commands
import SpecCnl.Units.FacetInstall
import SpecCnl.Units.Isolate
import SpecCnl.Units.Placement
import SpecCnl.Units.Receipts
import SpecCnl.Units.RunGraph
import SpecCnl.Units.RunSettle
import SpecCnl.Units.TrustRoute

/-!
# The corpus: reviewed controlled-language input

Each record below pairs one SPEC rule unit with **one** controlled-language sentence.

Read the direction of authority carefully, because the whole instrument depends on it.

* The SPEC prose is authoritative and is **not** parsed. Nothing here compiles English.
* The controlled sentence is a **hand rewrite**, reviewed as an input. It is not derived
  from the prose and no tool claims the two mean the same thing.
* `digest` is the SHA-256 of the rule-unit body exactly as `scripts/quality/spec.mjs`
  digests it. The gate recomputes it. When the prose moves, the digest breaks and the
  pairing returns for review; that is the only mechanism binding the two, and it is a
  review trigger, not a proof of agreement.
* `dropped` records, clause by clause, what the sentence does **not** carry. Not one
  sentence in this corpus carries everything its rule unit says.

Declaration names are derived from `key`, so a record cannot name a proposition, bridge,
or discharge that belongs to a different unit.

A rule unit is rendered by exactly one sentence. Multi-clause units coordinate inside the
controlled language with binary `and`, or with the explicitly delimited `and additionally`
form when exactly three sentence clauses are required. There is no Lean-level glue between
clauses and every connective a unit depends on is reviewed controlled language.

The records are grouped by SPEC domain, one module per group under `SpecCnl/Units/`, and
`units` below is their concatenation. Grouping is filing, not meaning: the gate reads
`units`, every record is the same shape, and a group is only the unit of review and of
parallel authorship.
-/

namespace SpecCnl.Corpus

/-- The first reviewed group: the pairings written while the instrument itself was being
built. Later groups live in `SpecCnl/Units/`. -/
private def coreUnits : List RuleUnit :=
  [ { key := "C13_RUN_ANCESTRY"
      atoms := ["C13-RUN-ANCESTRY"]
      specSection := "5.2"
      anchor := "SPEC.md:1601"
      digest := "a918901377c9455fd9632715990d25aecc26ace44315cdcd059b652f428b8ee0"
      sentence := "ancestry depends only on the commits"
      dropped :=
        [ "reachability queries as an obligation distinct from ancestry",
          "'not merely head moves' as a negative claim about conforming stores, which is \
           about store implementations rather than about the model" ] },
    { key := "C13_SUBSCRIPTION_ACCEPTED_TIERS"
      atoms := ["C13-SUBSCRIPTION-ACCEPTED-TIERS"]
      specSection := "6.1"
      anchor := "SPEC.md:2313"
      digest := "20e3a9bdfab3b04999e656fdcfedbe26a1912f6878e5862bc4fa1e03ee9f444d"
      sentence := "every tier predicate is the accepted set of some subscription"
      dropped :=
        [ "'TrustTier is categorical, not ordered': the absence of an order instance is a \
           signature-level negative and is not statable inside the theory. The sentence \
           states the strongest positive consequence instead, because an order would force \
           the accepted set to be an up-set",
          "'there is no minimum-tier comparison', the same signature-level negative" ] },
    { key := "C13_TRUST_VERIFIED_INGRESS"
      atoms := ["C13-TRUST-VERIFIED-INGRESS"]
      specSection := "6.1"
      anchor := "SPEC.md:2332"
      digest := "9ebcd9bde87e3425e17d8d52784607de4dc3f1ecd94dc56374becd3ef701dd26"
      sentence := "every published event has no asserted tier"
      dropped :=
        [ "'exposes declared endpoints': the model has no endpoint-declaration relation",
          "'verifies per verification': the model has no verification configuration",
          "'unverified requests MUST NOT mint Events'. THE SENTENCE IS WEAKER THAN THE \
           ATOM. The model has no ingress, and AgentCore.deriveChannelTrust maps \
           unverified provenance to TrustTier.external, so the model admits an Event \
           minted from an unverified request. The sentence carries only the \
           host-derives-the-tier half. A green bridge here is not evidence for the atom's \
           main clause" ] },
    { key := "C13_TURN_LEASE_EXPIRY"
      atoms := ["C13-TURN-LEASE-EXPIRY"]
      specSection := "5.3"
      anchor := "SPEC.md:2003"
      digest := "345c281041a50e304408102fe36242689c57f2b428dcc01eda7bbaf12e27ae03"
      sentence :=
        "every lease reclaim requires the recorded expiry is at most the stated time \
         for the reclaim"
      dropped :=
        [ "'expiresAt > now' as a requirement of every claim and renew, not only of reclaim",
          "'MUST be rejected without it' as a statement about the rejection path" ] },
    { key := "C13_EFFECT_ATTEMPT_IMMUTABLE"
      atoms := ["C13-EFFECT-ATTEMPT-IMMUTABLE"]
      specSection := "7.4"
      anchor := "SPEC.md:3023"
      digest := "741c0f0d88df53144d2be57aa6d78df5adccff0b2076413b7a3f11a87243f0c1"
      sentence := "every effect step maintains attempt immutability"
      dropped :=
        [ "'write-ahead': the model has no ordering between recording an attempt and the \
           effect crossing the boundary",
          "'that one item may cross the effect boundary'",
          "'Retry appends a new ordinal'",
          "'pre-effect denial or cancellation never creates one'" ] },
    { key := "C13_RECEIPT_ID_NAMESPACE"
      atoms := ["C13-RECEIPT-ID-NAMESPACE"]
      specSection := "7.4"
      anchor := "SPEC.md:3131"
      digest := "9659de19ad013cec0d4bb18385758e5836b1dc48f940f3bbe7e633520cf48ca4"
      sentence := "every effect step preserves disjoint receipt ids"
      dropped :=
        [ "'allocated from one owning-Actor namespace': AgentCore.ReceiptId carries no \
           owner, so the namespace is unrepresented and only the disjointness half is \
           expressible",
          "'AttemptReceipt.previous and AuditKind.receiptSuperseded refer to that same \
           namespace'",
          "'An id is never reused' as a claim over a whole run rather than over one step" ] },
    { key := "C13_RUN_GRAPH_ARITY"
      atoms := ["C13-RUN-GRAPH-ARITY"]
      specSection := "5.2"
      anchor := "SPEC.md:1607"
      digest := "1c9071af12794d003755e252eeac45d387f51c84239c66ac5b57921a4f34c598"
      sentence :=
        "every merge append requires the parent count equals two for the appended commit"
      dropped :=
        [ "'one root with zero parents': AgentCore.GraphLabel.append never carries a root \
           commit, since a root arrives through startRun or spawnChild, so a root clause \
           written over appends would be vacuously true and is refused rather than counted",
          "'exactly one parent equal to its branch head at append'",
          "'no other parent arity is valid' as an exhaustiveness claim over the arity rule, \
           which is a property of the definition rather than of a transition",
          "'Appending atomically advances only the target branch head'",
          "'Commit records and parent order never change'" ] },
    { key := "C13_RUN_UNDO_FENCE"
      atoms := ["C13-RUN-UNDO-FENCE"]
      specSection := "5.2"
      anchor := "SPEC.md:1592"
      digest := "98c0af4aa8faa9f44dffb722b1854786405837a5d32dac898a46eb376a146889"
      sentence :=
        "every undo append requires an unheld branch for the appended commit and every \
         undo append requires a selected ancestor for the appended commit"
      dropped :=
        [ "'MUST FIRST fence': the ordering is rendered as the source-state precondition \
           the model enforces, because the model has no temporal operator",
          "the concessive 'whether or not its lease has expired'",
          "the liveness half, 'rejected until the Turn is fenced or completes': a safety \
           reformulation carries the refusal but not the eventual admission" ] },
    { key := "C13_AUTH_GUEST_VERIFICATION"
      atoms := ["C13-AUTH-GUEST-VERIFICATION"]
      specSection := "3.3"
      anchor := "SPEC.md:394"
      digest := "8033772209b314ef230d10a32c48878e4ee1f41aef345f6067ad1aac42347b5f"
      sentence := "a verified guest subject holds before every role materialization"
      dropped :=
        [ "'a verification failure denies' as a statement about the denial path",
          "'the wire protocol for a token or a callback is a substrate/profile concern'",
          "'the host Tenant's policy declares the issuer or endpoint'",
          "'this document fixes the three schemes': a claim about the specification \
           document, not about the model" ] },
    { key := "C13_CONTENT_RESOLUTION"
      atoms := ["C13-CONTENT-RESOLUTION"]
      specSection := "8.2"
      anchor := "SPEC.md:3284"
      digest := "b81e0e0a785868b07c2713bdc8f6fe8b656fbdfb5ff12312b7f61b4fb9786c01"
      sentence :=
        "every content resolve requires a home tenant or a granted tenant for the \
         resolved reference"
      dropped :=
        [ "'Every ContentRef IN THIS SPECIFICATION': a claim about the specification \
           document, not about the model",
          "'MUST resolve through a ContentStore', and the enumeration of run inputs, \
           checkpoints, instructions, results, and slate sources",
          "'A ContentStore belongs to exactly one Tenant': AgentCore.ContentRef.tenant is \
           a field, so a rendering of this clause would be functional by construction and \
           therefore vacuous" ] },
    { key := "C13_RUN_ACCEPTANCE_OBLIGATION"
      atoms := ["C13-RUN-ACCEPTANCE-OBLIGATION"]
      specSection := "5.2"
      anchor := "SPEC.md:1759"
      digest := "956fa30bb46576efa28d801cbd136e8ec5765d57785f167829e33c93e5570063"
      sentence := "the head tree assigns at most one value"
      dropped :=
        [ "the declaration of criteria when a Run opens, and the refusal to redeclare one \
           identity with different verifiers",
          "'a verdict names exactly one criterion'",
          "satisfaction by an AcceptanceVerdict naming an attempted Receipt whose outcome \
           is succeeded and whose subject equals the head tree digest",
          "'the Receipt MUST come from the exact Operation the criterion names'",
          "snapshotting an unsatisfied obligation into the SettlementObligation, and the \
           rule that a Run is not Settled while it stands",
          "'A criterion bounds nothing', and the rule for a Run that declares none",
          "the sentence carries only the clause 'satisfaction is never selectable by the \
           caller that asks': the Run's head tree is a function of the store and the Run" ] },
    { key := "C13_CONFIG_SECRET_REF"
      atoms := ["C13-CONFIG-SECRET-REF"]
      specSection := "3.5"
      anchor := "SPEC.md:544"
      digest := "4ad4a717317cd79d759cb0ca55aef103de885e035b0e5a20c64fde36272aacdb"
      sentence := "every secret step preserves carrier refs only"
      dropped :=
        [ "'Configuration, manifests, and Blueprints carry SecretRefs': the model has no \
           configuration, manifest, or Blueprint record, so the carriers the sentence \
           quantifies over are the three the model does have — a delegation, a guest \
           Membership, and a cross-tenant reservation",
          "'A SecretRef is custody delegation, not process isolation', and the \
           plaintext-in-an-agent-visible-filesystem disclaimer: a negative claim about \
           what the ref does not protect, which the model cannot state because it has no \
           filesystem",
          "the SHOULD about credential-injecting seams, which is not a MUST and names no \
           model construct",
          "the ref's own shape '{ source, provider, id }': AgentCore.SecretRef carries \
           exactly those fields, so a rendering of this clause would be true by \
           construction and therefore vacuous" ] },
    { key := "C13_CONTENT_CUSTODY"
      atoms := ["C13-CONTENT-CUSTODY"]
      specSection := "8.2"
      anchor := "SPEC.md:3299"
      digest := "903c0d274ead9ee8c95bc355923e74f6f655bbc3b0bcb03996f56b7a67fb4a23"
      sentence :=
        "every content step preserves owned content stored and every content collect \
         requires an unowned reference for the collected content"
      dropped :=
        [ "'Every durable record type that names a ContentRef is a retained owner of that \
           content'. THE SENTENCE IS WEAKER THAN THE ATOM. \
           AgentCore.ContentLedger.owningRecords is populated only by an explicit own \
           step, so a record type that stores a reference without taking that step is \
           representable and is not excluded. What the sentence carries is \
           retention-safety-once-registered, not registration-on-naming",
          "the §8.4 rule 6 ownership map gaining a column naming the field and the \
           retention owner, which is a claim about a project artifact rather than about \
           the model",
          "'removing the record releases its ownership' for a record kind whose lifecycle \
           defines removal, such as a compacted View or ViewDelta revision",
          "the append-only and undeletable record kinds and what retention means for \
           them" ] },
    { key := "C13_AUTH_SCOPE_DIRECTION"
      atoms := ["C13-AUTH-SCOPE-DIRECTION"]
      specSection := "3.2"
      anchor := "SPEC.md:255"
      digest := "b3f928b67c1405c5c5b88d3c0b37aeca9d9167252747c99718d2b98874bfbe31"
      sentence := "scope reach is transitive and scope reach is antisymmetric"
      dropped :=
        [ "'unless a deny on the ordered Tenant-to-target path removes it': the \
           deny-defeats-allow half is a property of AuthorityLedger Grants, not of the \
           chain relation the sentence is about",
          "'quotas, retention, and the rest of a PolicySet resolve the same way': the \
           model has no PolicySet",
          "'A record belongs to exactly the Scope that holds it', and the prohibition on \
           an ancestor's Facet install composing into a descendant",
          "'Events do not ascend either', and the confinement of an EventPattern that \
           names no Scope",
          "'Nothing else traverses the chain' as an exhaustiveness claim over traversal, \
           which is a claim about the specification's own coverage rather than a \
           statable property of the relation" ] },
    { key := "C13_AUDIT_EDGE_RELATION"
      atoms :=
        ["C13-AUDIT-EDGE-RELATION", "C13-AUDIT-PREEXISTING-CAUSE", "C13-AUDIT-APPEND-ONLY"]
      specSection := "7.4"
      anchor := "SPEC.md:3233"
      digest := "6af0e810ad8fd6775a1a7c7114ddeb07850ec0e7659ab3f136579ec4f88480a2"
      sentence :=
        "every audit step maintains recorded entry immutability and \
         every audit step maintains a typed lower local cause"
      dropped :=
        [ "the enumeration of permitted typed edges. The sentence carries \
           AgentCore.MayCause as the typed-edge relation without stating which pairs it \
           admits, so a wrong pair in that definition would not fail this bridge",
          "'share tenant and correlation': AgentCore.AuditEntry carries a correlation but \
           no tenant, so only the correlation half is carried",
          "'Invocation records are ordinary roots', the target-local routeProjected bridge \
           root, and the host-created command-rejection root: the sentence says nothing \
           about which entries may stand with no cause at all",
          "'ReceiptSuperseded is a specialized append caused by its prior indeterminate \
           Receipt and names the final next Receipt'",
          "the second clause is existential in the appended entry, because \
           AgentCore.AuditStep does not expose the appended id in its label. A step that \
           appended two entries and satisfied the cause condition for one of them would \
           pass, so the clause is weaker than 'every cause MUST exist before append'" ] },
    { key := "C13_ROUTE_DELIVERY_ONCE"
      atoms := ["C13-ROUTE-DELIVERY-ONCE"]
      specSection := "6.2"
      anchor := "SPEC.md:2461"
      digest := "8a296cd0363fd7db0160abcc8a5445f1312ec47497219ebd74589aa01324d1cc"
      sentence :=
        "every routing step maintains consumed key persistence and every subscription firing \
         requires an unconsumed event key for the firing"
      dropped :=
        [ "'(subscription, dedupeKey) identifies one reservation and one stable \
           InvocationId': the routing ledger has no RouteReservation and derives no \
           InvocationId, so the sentence carries the dedupe consequence and not the \
           identity claim",
          "'A reservation has at most one terminal RouteDelivery — admission writes it \
           — and it is written once'",
          "'sourceAuditCause MUST be the preexisting source-Actor Event AuditRecord for \
           that reservation's event field and causes the source-local reservation audit \
           entry'",
          "'The source-owned reservation is the only cross-Actor causal bridge', and the \
           cause-free target-local routeProjected bridge root its authenticated \
           projection admits" ] },
    { key := "C13_ENVIRONMENT_SESSION_LIFECYCLE"
      atoms :=
        ["C13-ENVIRONMENT-STALE-SESSION", "C13-ENVIRONMENT-ROTATION",
          "C13-ENVIRONMENT-DISPOSE-CLOSE"]
      specSection := "4.5"
      anchor := "SPEC.md:1186"
      digest := "d116de38e8630ee540940a2de132f8f0a9adc19e753d16450526d7aeab85dbef"
      sentence :=
        "every environment step requires a live current session for the session use and \
         every environment rotation maintains session records and additionally every \
         session close establishes disposed child facets for the closed session"
      dropped :=
        [ "the model represents disposal observably: the Session becomes closed, its \
           files disappear, and every exposure it held becomes non-live. It has no live \
           Facet resource object, so the disposal clause does not claim mechanics beyond \
           those post-state facts",
          "the environment profiles' further definitions — snapshot and restore, \
           ephemeral-filesystem durability, preview exposure, and the credential-isolation \
           seam — which §11 owns",
          "the first clause carries staleness as the positive precondition every admitted \
           use satisfies rather than as the refusal the atom words it as. The two are \
           contrapositives in the model, and AgentCore.stale_session_admits_nothing is \
           the refusal form" ] },
    { key := "C13_PLACEMENT_DYNAMIC_NO_EGRESS"
      atoms := ["C13-PLACEMENT-DYNAMIC-NO-EGRESS"]
      specSection := "1.5"
      anchor := "SPEC.md:161"
      digest := "36eb51b0d7b05669b6a43ef90f73d2b4ca1edca1a2fba7e3a13e658b8e1153ee"
      sentence :=
        "every fresh isolate step requires a host pass and every isolate egress requires a \
         passed destination for the egress"
      dropped :=
        [ "'globalOutbound: null' as the concrete host configuration that realizes the \
           fresh-state rule. The sentence carries the exhaustive transition consequence \
           — only a host pass can be the first step — not that implementation spelling",
          "'The rule is at the substrate and not in a policy layer', a claim about where \
           the rule lives rather than about what it forbids",
          "'every externalSend obligation in §11 rests on the difference', a \
           cross-reference to profile obligations",
          "'a domain in which code can open a connection the platform did not give it is \
           not a dynamic domain', which is definitional rather than a transition rule" ] },
    { key := "C13_RUN_BINARY_TREE_MERGE"
      atoms := ["C13-RUN-BINARY-TREE-MERGE"]
      specSection := "5.2"
      anchor := "SPEC.md:1842"
      digest := "1c9435c5ad3a97343920081244e63a9e55b80bd0774e62dc6ebf80659e02b2d5"
      sentence :=
        "every merge append requires the parent count is at most two for the appended commit"
      dropped :=
        [ "'over the same Environment and one common-ancestor tree'",
          "'The platform MUST resolve the tree separately and record the outcome on the \
           merge commit's treeCheckpoint'",
          "'policies.treeMerge is a field of PolicySet alongside tiers, approvals, and \
           placement', and the three settings it names",
          "the sentence bounds the parent count of the merge commit rather than the number \
           of tree inputs. The model has no separate tree-input arity, so the \
           same-binary-parent-pair half is what is carried and 'more than two tree inputs \
           is invalid' is carried only through it" ] },
    { key := "C13_INTERCEPTOR_ORDER"
      atoms := ["C13-INTERCEPTOR-ORDER"]
      specSection := "4.4"
      anchor := "SPEC.md:1061"
      digest := "4ed34d91ac17e570f62cfd40a084af335344bc5c09c4cfb0ea667efc2c494844"
      sentence := "interceptor ordering is transitive and interceptor ordering is irreflexive"
      dropped :=
        [ "'Ordering is total': AgentCore.interceptor_order_total proves totality only up \
           to two contributions naming the same interceptor in the same mode, so the \
           model's totality is modulo that pair rather than up to equality, and the \
           grammar has no polymorphic form for a quotient",
          "'ascending (mode, priority, facetId, interceptorId)' as the exact key, and \
           'mode runs every rewrite interceptor ahead of every gate interceptor and \
           dominates every local priority'. The band-dominance clause needs a relation \
           restricted by two common nouns, which application alone cannot form",
          "'interceptor ids MUST be unique within a Facet'",
          "'Hosts record which interceptor last rewrote a value'" ] },
    { key := "C13_BLUEPRINT_REMATERIALIZE"
      atoms := ["C13-BLUEPRINT-REMATERIALIZE"]
      specSection := "9.2"
      anchor := "SPEC.md:3546"
      digest := "0610d92856dfc1817a34f6fcc97863603f005f3308c65773714179f6f5e19c94"
      sentence :=
        "every template materialization requires an unmaterialized template \
         for the materialization"
      dropped :=
        [ "'MUST project a Blueprint into records — Facet installs, Bindings, \
           Subscriptions, slots, policies, scope scaffolding': the model materializes \
           Subscriptions only",
          "'re-applying reconciles (create, update, remove-managed) rather than \
           duplicates': the sentence carries the never-duplicates half. The model's \
           reconcile is a stored identity with no update and no remove-managed path",
          "'Materialized records are marked Blueprint-managed; manual edits to managed \
           records are rejected or adopted explicitly, per policy'",
          "'The materializer enforces slot contribute-authority, command uniqueness, and \
           role-to-Grant materialization through the same records the runtime uses'",
          "C13-BLUEPRINT-RUN-PINS is not claimed. No materializer-to-RunPins \
           reconciliation relation exists in the formal model, so no dedicated \
           postcondition can be discharged without fabricating one" ] },
    { key := "C13_ENVIRONMENT_TURN_OWNED"
      atoms := ["C13-ENVIRONMENT-TURN-OWNED"]
      specSection := "4.5"
      anchor := "SPEC.md:1197"
      digest := "c1f2ade775bff80f7d0d10996c6949a5b1a759a75369332753d7a0608eb206a1"
      sentence := "every environment step requires an owning turn lease for the session use"
      dropped :=
        [ "'exactly one Turn opened it': AgentCore.SessionRecord.owner is a field, so a \
           rendering of this clause would be functional by construction and therefore \
           vacuous",
          "'it closes when that Turn reaches a terminal status': the model has no Turn \
           status, so nothing connects a terminal Turn to a close step",
          "'A Turn-owned Session cannot be shared and cannot outlive its Turn' as a \
           lifetime claim over a whole trace rather than over one step",
          "'§7.2 keys an enforcement floor on this property, so it is a condition a \
           platform tests rather than assumes', a claim about another section's use of \
           the property" ] },
    { key := "C13_AUTH_SECRET_SCOPE"
      atoms := ["C13-AUTH-SECRET-SCOPE"]
      specSection := "3.5"
      anchor := "SPEC.md:591"
      digest := "d4dbf5485acfc06a8bfda504a26fd51bdbe76d2fdd81ef7b2d257af5ffd3a178"
      sentence := "every secret resolve requires a home tenant consumer for the resolved secret"
      dropped :=
        [ "'and Principal-independent': AgentCore.SecretLabel.resolve carries no \
           Principal, so the independence clause has nothing to range over and a \
           rendering would be vacuous",
          "'A resolution seam decides from the presented (SecretRef, consumer, endpoint) \
           triple and the custody record alone': the sentence carries the Tenant half of \
           the triple, and AgentCore.secret_resolution_requires_current_custody is where \
           the Binding and endpoint halves live",
          "'two Principals of one Tenant presenting an identical triple through the same \
           consumer observe the identical secret and the identical refusal'",
          "'a SecretRef is not an access-control primitive and MUST NOT be used as one'",
          "'A recorded custody fact carrying any discriminant beyond its SecretRef and \
           endpoint ... MUST be refused where it is written rather than honored as a \
           narrower scope'" ] },
    { key := "C13_PREPARED_APPROVAL_UNIQUE"
      atoms := ["C13-PREPARED-APPROVAL-UNIQUE"]
      specSection := "7.3"
      anchor := "SPEC.md:2996"
      digest := "306d0e189ffc72180a931e223468287fb0f47732c9927c660a730b8419489a88"
      sentence := "approval mapping assigns at most one value"
      dropped :=
        [ "'An Approval authorizes exactly one InvocationId and its intentDigest': the \
           mapping in the sentence establishes one Approval per Invocation, not the \
           Approval's exact identity and digest fields",
          "AgentCore.ApprovalLedger.approvalFor is a function field, so the at-most-one \
           property is structural in the model. It cannot distinguish an implementation \
           relation that tries to store two records; the bridge does not claim that it can",
          "'An InvocationContinuation MUST be absent before first consumption', which \
           is C13-PREPARED-CONTINUATION-ABSENT and is not carried by this sentence",
          "approval expiry, terminality, persistence across process death, and the \
           exact-token rule for resume",
          "deniedPreEffect and cancelledPreEffect Receipt outcomes and the prohibition \
           on creating an EffectAttempt for either",
          "the guarded first-attempt transition and every later continuation validation" ] },
    { key := "C13_PROTOCOL_DUPLICATE"
      atoms := ["C13-PROTOCOL-DUPLICATE"]
      specSection := "8.5"
      anchor := "SPEC.md:3416"
      digest := "deeddd50561149e157b6e16906b41ca81c2af6f536d2c94826868ea70fcdab57"
      sentence :=
        "every duplicate submission maintains reservation and event identity and every \
         duplicate submission establishes a recorded original reply for the duplicate"
      dropped :=
        [ "the required order before duplicate lookup — decode and shape, exact caller \
           authentication, then duplicate lookup — and the later authority, lifecycle, \
           expected-revision, and optional-LeaseToken gates",
          "the exact `(caller, idempotencyKey)` shape of the duplicate identity. The \
           model's SubmissionIdentity contains a caller and key, but the sentence does \
           not expose their fields",
          "'record duplicateOf' as a WireRecord field: the sentence carries the formal \
           SubmissionOutcome.duplicate original id instead",
          "'without re-running later gates or mutation': the sentence carries the \
           observable no-new-reservation/no-new-Event consequence, not the internal \
           dispatcher control-flow claim",
          "C13-PROTOCOL-OUTCOMES and C13-PROTOCOL-EXACT-ENVELOPE, which share the rule \
           unit but are not claimed by this corpus unit" ] } ]

/-- The whole corpus: every reviewed group, concatenated. A group is appended here and
nowhere else, so adding one is a two-line diff and the gate keeps reading one list. -/
def units : List RuleUnit :=
  coreUnits ++ Units.Auth.units ++ Units.Isolate.units ++ Units.Commands.units ++
    Units.FacetInstall.units ++ Units.Placement.units ++ Units.RunGraph.units ++
    Units.TrustRoute.units ++ Units.Claims.units ++ Units.Receipts.units ++
    Units.RunSettle.units

/-- The unit with this key, if any. -/
def find? (key : String) : Option RuleUnit := units.find? (fun unit => unit.key == key)

/-- Every audited declaration in the corpus, in report order. -/
def auditedNames : List String := (units.map RuleUnit.auditedNames).flatten

/-- Kernel-checked divergence evidence, audited alongside the units. A finding that has
been resolved in the model stays here as a discriminating witness: see
`SpecCnl.Divergence` for why removing it would discard the only evidence that the
resolving premise does any work. -/
def divergenceNames : List String :=
  [ "SpecCnl.Divergence.preFixOrderingHolds",
    "SpecCnl.Divergence.prefix_guest_verification_diverges",
    "SpecCnl.Divergence.current_step_is_prefix_step",
    "SpecCnl.Divergence.fix_is_strict" ]

/-- Every declaration the axiom report designates. -/
def allAuditedNames : List String := auditedNames ++ divergenceNames

/-- Structural refusals of the corpus itself: a duplicate key, a duplicate atom, an empty
atom list, or a digest that is not a lowercase SHA-256. -/
def corpusRefusals : List String := Id.run do
  let mut refusals : List String := []
  let mut keys : List String := []
  let mut atoms : List String := []
  for unit in units do
    if keys.contains unit.key then
      refusals := refusals ++ [s!"duplicate corpus key '{unit.key}'"]
    keys := unit.key :: keys
    if unit.atoms.isEmpty then
      refusals := refusals ++ [s!"corpus unit '{unit.key}' names no atom"]
    for atom in unit.atoms do
      if atoms.contains atom then
        refusals := refusals ++ [s!"atom '{atom}' is claimed by more than one corpus unit"]
      atoms := atom :: atoms
    if unit.digest.length != 64 ||
        !unit.digest.all (fun c => c.isDigit || (c >= 'a' && c <= 'f')) then
      refusals := refusals ++ [s!"corpus unit '{unit.key}' digest is not a SHA-256 hex digest"]
    if unit.dropped.isEmpty then
      refusals := refusals ++
        [s!"corpus unit '{unit.key}' records no dropped clause; not one sentence in this \
            corpus carries everything its rule unit says, so an empty list is unreviewed \
            rather than complete"]
  return refusals

end SpecCnl.Corpus
