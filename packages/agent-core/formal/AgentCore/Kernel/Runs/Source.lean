/-
Authoritative source revisions (SPEC §5.2, §9.1; `packages/agent-core/src/agents/source.ts`).

A Run's pins name exact source revisions, and these are the records those revisions are:
the Agent revision, which additionally names the profile, policy, model policy, and
Environment it resolved to, and the two policy revisions, which carry nothing but the base
four fields. The runtime writes all three through one generic `SourceCodec` at `1.0`; this
module does the same, with `SourceRevisionRecord` parameterised by the identifier kind so
the policy and model-policy records are one definition rather than two copies.

The direct constructors in `source.ts` validate nothing — every shape rule lives in
`fromData`, because the typed fields are the invariant. Here the typed fields *are* the
invariant, enforced at construction, so the kernel has no unvalidated direct path at all;
what remains to state is the codec laws.

The one decision this module does carry is the port's: `RunSourceRevisionPort.verify` and
`verifyPackageClosure` must both return exactly `true`, and anything else is
`run.invalid-state`. The runtime distinguishes the genesis and migration messages, which
this module does not model — messages are prose, the code is the contract — but the two call
sites are named in `admitSourceRevisions`' documentation so the correspondence is not lost.
-/
import AgentCore.Kernel.Core

namespace AgentCore.Kernel

/-- The four fields every source revision record carries, indexed by the identifier kind
that names it. `AgentPolicyRevisionRecord` and `ModelPolicyRevisionRecord` are exactly this
record at two kinds. -/
structure SourceRevisionRecord (kind : IdKind) where
  id : TextId kind
  revision : Revision
  content : ContentRef
  digest : Digest
  deriving DecidableEq

namespace SourceRevisionRecord

variable {kind : IdKind}

/-- The four base fields as JSON, in the canonical order `baseData` writes them. -/
def baseEntries (record : SourceRevisionRecord kind) : List (String × Json.JsonValue) :=
  [("content", .str record.content.value),
   ("digest", .str record.digest.value),
   ("id", .str record.id.value),
   ("revision", .int record.revision.value)]

def toJson (record : SourceRevisionRecord kind) : Json.JsonValue := .obj record.baseEntries

/-- `sourceFields`: exactly `content`, `digest`, `id`, `revision`. -/
def readBase (kind : IdKind) (entries : List (String × Json.JsonValue)) (subject : String) :
    Outcome (SourceRevisionRecord kind) :=
  match Json.field entries "content", Json.field entries "digest", Json.field entries "id",
      Json.field entries "revision" with
  | some (.str contentText), some (.str digestText), some (.str idText),
      some (.int revisionValue) =>
      match ContentRef.parse contentText, Digest.parse digestText,
          TextId.parse kind idText with
      | .ok content, .ok digest, .ok id =>
          if revisionValue < 0 then unshaped subject
          else
            match Revision.parse revisionValue.natAbs with
            | .ok revision => .ok ⟨id, revision, content, digest⟩
            | .error fault => .error fault
      | _, _, _ => unshaped subject
  | _, _, _, _ => unshaped subject

def ofJson (kind : IdKind) (value : Json.JsonValue) (subject : String) :
    Outcome (SourceRevisionRecord kind) :=
  match Json.asObject value subject with
  | .error fault => .error fault
  | .ok entries =>
      if Json.exactFields entries ["content", "digest", "id", "revision"] then
        readBase kind entries subject
      else unshaped subject

theorem ofJson_toJson (record : SourceRevisionRecord kind) (subject : String) :
    ofJson kind record.toJson subject = .ok record := by
  obtain ⟨id, revision, content, digest⟩ := record
  have contentParse : ContentRef.parse content.value = .ok content := ContentRef.parse_value content
  have digestParse : Digest.parse digest.value = .ok digest := by
    unfold Digest.parse
    simp [digest.valid]
  have idParse : TextId.parse kind id.value = .ok id := by
    unfold TextId.parse
    simp [id.valid]
  have revisionParse : Revision.parse revision.value = .ok revision := by
    unfold Revision.parse
    simp [revision.valid]
  have nonneg : ¬ ((revision.value : Int) < 0) := by omega
  have magnitude : ((revision.value : Int)).natAbs = revision.value := by omega
  simp [toJson, baseEntries, ofJson, readBase, Json.asObject, Json.exactFields, Json.keys,
    Json.field, List.find?, contentParse, digestParse, idParse, nonneg, magnitude,
    revisionParse]

theorem canonical_toJson (record : SourceRevisionRecord kind) :
    Json.canonical record.toJson = true := by
  have ordered : Text.strictlyOrdered ["content", "digest", "id", "revision"] = true := by decide
  simp [toJson, baseEntries, Json.canonical, Json.canonicalEntries, ordered]

end SourceRevisionRecord

/-- The runtime's generic `SourceCodec`: one encoder, one decoder, one version, and a kind
string per record. -/
def sourceRevisionCodec (kind : IdKind) (recordKind subject : String) :
    RecordCodec (SourceRevisionRecord kind) where
  kind := recordKind
  version := ⟨1, 0⟩
  encodePayload := SourceRevisionRecord.toJson
  decodePayload := fun value => SourceRevisionRecord.ofJson kind value subject
  roundTrip := fun record => SourceRevisionRecord.ofJson_toJson record subject
  canonicalPayload := SourceRevisionRecord.canonical_toJson

/-- `AgentPolicyRevisionRecordCodec`. -/
def agentPolicyRevisionCodec : RecordCodec (SourceRevisionRecord .agentPolicy) :=
  sourceRevisionCodec .agentPolicy "agent.policy-revision" "Agent policy revision"

/-- `ModelPolicyRevisionRecordCodec`. -/
def modelPolicyRevisionCodec : RecordCodec (SourceRevisionRecord .modelPolicy) :=
  sourceRevisionCodec .modelPolicy "agent.model-revision" "Model policy revision"

/-- `AgentRevisionRecord`: the base four fields plus the four identities the Agent revision
resolved to. -/
structure AgentRevisionRecord where
  id : TextId .agent
  revision : Revision
  content : ContentRef
  digest : Digest
  profile : TextId .agentProfile
  policy : TextId .agentPolicy
  model : TextId .modelPolicy
  environment : TextId .environment
  deriving DecidableEq

namespace AgentRevisionRecord

/-- The base four fields of this record, read as a `SourceRevisionRecord`. The runtime
shares them through `RevisionRecord.baseData`; here they are shared through the record the
policy revisions already are, so there is one definition of the base shape. -/
def base (record : AgentRevisionRecord) : SourceRevisionRecord .agent :=
  ⟨record.id, record.revision, record.content, record.digest⟩

/-- `toData`: the base four plus `environment`, `model`, `policy`, `profile`, written in
canonical key order. -/
def toJson (record : AgentRevisionRecord) : Json.JsonValue :=
  .obj [("content", .str record.content.value),
        ("digest", .str record.digest.value),
        ("environment", .str record.environment.value),
        ("id", .str record.id.value),
        ("model", .str record.model.value),
        ("policy", .str record.policy.value),
        ("profile", .str record.profile.value),
        ("revision", .int record.revision.value)]

def ofJson (value : Json.JsonValue) : Outcome AgentRevisionRecord :=
  match Json.asObject value "Agent revision" with
  | .error fault => .error fault
  | .ok entries =>
      if Json.exactFields entries
          ["content", "digest", "environment", "id", "model", "policy", "profile", "revision"]
        then
          match SourceRevisionRecord.readBase .agent entries "Agent revision" with
          | .error fault => .error fault
          | .ok base =>
              match Json.field entries "environment", Json.field entries "model",
                  Json.field entries "policy", Json.field entries "profile" with
              | some (.str environmentText), some (.str modelText), some (.str policyText),
                  some (.str profileText) =>
                  match TextId.parse .environment environmentText,
                      TextId.parse .modelPolicy modelText,
                      TextId.parse .agentPolicy policyText,
                      TextId.parse .agentProfile profileText with
                  | .ok environment, .ok model, .ok policy, .ok profile =>
                      .ok ⟨base.id, base.revision, base.content, base.digest, profile, policy,
                            model, environment⟩
                  | _, _, _, _ => unshaped "Agent revision"
              | _, _, _, _ => unshaped "Agent revision"
        else unshaped "Agent revision"

theorem ofJson_toJson (record : AgentRevisionRecord) : ofJson record.toJson = .ok record := by
  obtain ⟨id, revision, content, digest, profile, policy, model, environment⟩ := record
  have contentParse : ContentRef.parse content.value = .ok content := ContentRef.parse_value content
  have digestParse : Digest.parse digest.value = .ok digest := by
    unfold Digest.parse
    simp [digest.valid]
  have idParse : TextId.parse .agent id.value = .ok id := by
    unfold TextId.parse
    simp [id.valid]
  have profileParse : TextId.parse .agentProfile profile.value = .ok profile := by
    unfold TextId.parse
    simp [profile.valid]
  have policyParse : TextId.parse .agentPolicy policy.value = .ok policy := by
    unfold TextId.parse
    simp [policy.valid]
  have modelParse : TextId.parse .modelPolicy model.value = .ok model := by
    unfold TextId.parse
    simp [model.valid]
  have environmentParse : TextId.parse .environment environment.value = .ok environment := by
    unfold TextId.parse
    simp [environment.valid]
  have revisionParse : Revision.parse revision.value = .ok revision := by
    unfold Revision.parse
    simp [revision.valid]
  have nonneg : ¬ ((revision.value : Int) < 0) := by omega
  have magnitude : ((revision.value : Int)).natAbs = revision.value := by omega
  simp [toJson, ofJson, SourceRevisionRecord.readBase, Json.asObject, Json.exactFields,
    Json.keys, Json.field, List.find?, contentParse, digestParse, idParse, profileParse,
    policyParse, modelParse, environmentParse, nonneg, magnitude, revisionParse]

theorem canonical_toJson (record : AgentRevisionRecord) :
    Json.canonical record.toJson = true := by
  have ordered : Text.strictlyOrdered
      ["content", "digest", "environment", "id", "model", "policy", "profile", "revision"]
      = true := by decide
  simp [toJson, Json.canonical, Json.canonicalEntries, ordered]

end AgentRevisionRecord

/-- `AgentRevisionRecordCodec`. -/
def agentRevisionCodec : RecordCodec AgentRevisionRecord where
  kind := "agent.revision"
  version := ⟨1, 0⟩
  encodePayload := AgentRevisionRecord.toJson
  decodePayload := AgentRevisionRecord.ofJson
  roundTrip := AgentRevisionRecord.ofJson_toJson
  canonicalPayload := AgentRevisionRecord.canonical_toJson

/-- `RunSourceRevisionPort`'s two answers, read as one decision.

`createRunInTransaction` and the migration path each require *both* of the port's answers to
be exactly `true` — the configuration must resolve exact authoritative source revisions and
the pinned Package set must be the verified closure. Neither is a fact a record can carry,
so the port supplies them and this is what the runtime does with the pair: a refusal
carrying `run.invalid-state`, which is the same code at genesis and at migration even though
the runtime's two messages differ. -/
def admitSourceRevisions (verified closureVerified : Bool) : Outcome Unit :=
  if verified && closureVerified then .ok () else refuse .runInvalidState

/-- **An unverified source configuration is refused.** -/
theorem admitSourceRevisions_requires_verification {closureVerified : Bool} :
    (admitSourceRevisions false closureVerified).RefusedWith .runInvalidState := by
  unfold admitSourceRevisions
  simp [refuse, Outcome.RefusedWith]

/-- **An unverified Package closure is refused, whatever the revisions say.** SPEC §9.1's
closure rule is not implied by exact revisions: a pin set can name exact revisions and still
not be the transitive closure, and this is the refusal that separates the two. -/
theorem admitSourceRevisions_requires_closure {verified : Bool} :
    (admitSourceRevisions verified false).RefusedWith .runInvalidState := by
  unfold admitSourceRevisions
  simp [refuse, Outcome.RefusedWith]

/-- **Both answers together admit, and nothing less does.** -/
theorem admitSourceRevisions_iff {verified closureVerified : Bool} :
    admitSourceRevisions verified closureVerified = .ok () ↔
      (verified = true ∧ closureVerified = true) := by
  unfold admitSourceRevisions
  cases verified <;> cases closureVerified <;> simp [refuse]

end AgentCore.Kernel
