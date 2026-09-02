/-
Record codecs (SPEC §8.3; `packages/agent-core/src/core/codec.ts`).

Every durable record is written through one codec, and that codec answers exactly one
compatibility question: `supportsRecordVersion` — same major, and a minor no newer than the
reader's. The refusals it earns are named: an unknown major is `codec.unknown-major`, a
newer minor within a known major is `codec.invalid`, and an older minor is *read*, which is
what "tolerant read and upcast within a major" means. A record set's declaration asks the
same predicate, so a set and a single record can never disagree about readability, and a
kind the reader does not declare at all is `schema.unreadable`.

The runtime's `decode` also converts: a `TypeError` thrown by a payload reader becomes a
`codec.invalid` refusal, while an `AgentCoreError` passes through unchanged. `throughCodec`
is that conversion, and it is the only place the kernel crosses its two channels.

Two laws are structure fields rather than separate theorems, because "a record without a
codec is unfinished" is only enforceable if the codec cannot exist without them: a
`RecordCodec` carries the proof that its decode inverts its encode, and the proof that what
it writes is canonical. A codec that cannot prove both does not typecheck.
-/
import AgentCore.Kernel.Core.Json

namespace AgentCore.Kernel

/-- `RecordVersion`: the `{major, minor}` tag every envelope carries. -/
structure RecordVersion where
  major : Nat
  minor : Nat
  deriving DecidableEq, Repr

/-- The single §8.3 compatibility decision. -/
def supportsRecordVersion (declared supported : RecordVersion) : Bool :=
  declared.major == supported.major && declared.minor ≤ supported.minor

/-- The refusal `supportsRecordVersion` earned, or none where the pair is compatible. -/
def versionRefusal (declared supported : RecordVersion) : Option ErrorCode :=
  if supportsRecordVersion declared supported then none
  else if declared.major == supported.major then some .codecInvalid
  else some .codecUnknownMajor

/-- **An unknown major is refused as `codec.unknown-major`.** -/
theorem versionRefusal_unknown_major {declared supported : RecordVersion}
    (differs : declared.major ≠ supported.major) :
    versionRefusal declared supported = some .codecUnknownMajor := by
  unfold versionRefusal supportsRecordVersion
  simp [differs]

/-- **A newer minor inside a known major is refused as `codec.invalid`.** -/
theorem versionRefusal_newer_minor {declared supported : RecordVersion}
    (same : declared.major = supported.major) (newer : supported.minor < declared.minor) :
    versionRefusal declared supported = some .codecInvalid := by
  unfold versionRefusal supportsRecordVersion
  have unsupported : ¬ declared.minor ≤ supported.minor := by omega
  simp [same, unsupported]

/-- **An older or equal minor inside the same major is read.** This is the tolerant-read
rule: a reader serves records written by any earlier minor of its own major. -/
theorem versionRefusal_tolerant {declared supported : RecordVersion}
    (same : declared.major = supported.major) (older : declared.minor ≤ supported.minor) :
    versionRefusal declared supported = none := by
  unfold versionRefusal supportsRecordVersion
  simp [same, older]

/-- The envelope a codec writes: kind, version tag, payload. -/
structure Envelope where
  kind : String
  version : RecordVersion
  payload : Json.JsonValue

namespace Envelope

/-- The envelope's canonical JSON. Keys are emitted in canonical order, so the encoder
never depends on a later sort to make its bytes canonical. -/
def toJson (envelope : Envelope) : Json.JsonValue :=
  .obj [("kind", .str envelope.kind),
        ("payload", envelope.payload),
        ("version", .obj [("major", .int envelope.version.major),
                          ("minor", .int envelope.version.minor)])]

/-- `isEnvelope`: exactly the three fields, a string kind, and a non-negative integer
version pair. Anything else is malformed, which the runtime reports as `codec.invalid`. -/
def ofJson (value : Json.JsonValue) : Outcome Envelope :=
  match value with
  | .obj entries =>
      if Json.exactFields entries ["kind", "payload", "version"] then
        match Json.field entries "kind", Json.field entries "payload",
            Json.field entries "version" with
        | some (.str kind), some payload, some (.obj versionEntries) =>
            if Json.exactFields versionEntries ["major", "minor"] then
              match Json.field versionEntries "major", Json.field versionEntries "minor" with
              | some (.int major), some (.int minor) =>
                  if major < 0 || minor < 0 then refuse .codecInvalid
                  else .ok ⟨kind, ⟨major.natAbs, minor.natAbs⟩, payload⟩
              | _, _ => refuse .codecInvalid
            else refuse .codecInvalid
        | _, _, _ => refuse .codecInvalid
      else refuse .codecInvalid
  | _ => refuse .codecInvalid

theorem ofJson_toJson (envelope : Envelope) : ofJson envelope.toJson = .ok envelope := by
  cases envelope with
  | mk kind version payload =>
      cases version with
      | mk major minor =>
          have nonneg : (((major : Int) < 0) || ((minor : Int) < 0)) = false := by
            simp
          unfold ofJson toJson
          simp [Json.exactFields, Json.keys, Json.field, List.find?, nonneg]

/-- **An envelope's canonical JSON is canonical whenever its payload is.** -/
theorem canonical_toJson {envelope : Envelope}
    (payload : Json.canonical envelope.payload = true) :
    Json.canonical envelope.toJson = true := by
  have outer : Text.strictlyOrdered ["kind", "payload", "version"] = true := by decide
  have inner : Text.strictlyOrdered ["major", "minor"] = true := by decide
  unfold toJson
  simp [Json.canonical, Json.canonicalEntries, outer, inner, payload]

end Envelope

/-- Domain refusals pass through the codec boundary; a payload reader's shape violation
becomes the `codec.invalid` refusal the runtime's `catch` produces. -/
def throughCodec : Fault → Fault
  | .refusal code => .refusal code
  | .shape _ => .refusal .codecInvalid

/-- One record kind's codec: the envelope tag it writes, the payload functions, and the two
laws every codec in the codebase is required to satisfy. -/
structure RecordCodec (α : Type) where
  kind : String
  version : RecordVersion
  encodePayload : α → Json.JsonValue
  decodePayload : Json.JsonValue → Outcome α
  /-- §8.3: the decode inverts the encode. Without this a codec is decoration. -/
  roundTrip : ∀ record : α, decodePayload (encodePayload record) = .ok record
  /-- What the codec writes is canonical at every depth, so its bytes are the canonical
  bytes and a digest over them is stable. -/
  canonicalPayload : ∀ record : α, Json.canonical (encodePayload record) = true

namespace RecordCodec

variable {α : Type}

def encode (codec : RecordCodec α) (record : α) : Json.JsonValue :=
  (Envelope.mk codec.kind codec.version (codec.encodePayload record)).toJson

/-- The canonical text a stored record occupies. -/
def canonicalText (codec : RecordCodec α) (record : α) : List Char :=
  Json.canonicalText (codec.encode record)

def decode (codec : RecordCodec α) (value : Json.JsonValue) : Outcome α :=
  match Envelope.ofJson value with
  | .error fault => .error fault
  | .ok envelope =>
      if envelope.kind == codec.kind then
        match versionRefusal envelope.version codec.version with
        | some code => refuse code
        | none =>
            match codec.decodePayload envelope.payload with
            | .ok record => .ok record
            | .error fault => .error (throughCodec fault)
      else refuse .codecInvalid

/-- **Every codec round-trips through its envelope.** -/
theorem decode_encode (codec : RecordCodec α) (record : α) :
    codec.decode (codec.encode record) = .ok record := by
  unfold decode encode
  rw [Envelope.ofJson_toJson]
  simp only [beq_self_eq_true, if_true,
    versionRefusal_tolerant (rfl : codec.version.major = codec.version.major)
      (Nat.le_refl codec.version.minor)]
  rw [codec.roundTrip record]

/-- **What a codec writes is canonical.** -/
theorem canonical_encode (codec : RecordCodec α) (record : α) :
    Json.canonical (codec.encode record) = true :=
  Envelope.canonical_toJson (codec.canonicalPayload record)

/-- **Canonical bytes identify records.** Two records of one kind whose stored text agrees
are the same record — the property `canonicalJsonEqual` is used for throughout the runtime,
here without a number-rendering assumption. -/
theorem canonicalText_injective {codec : RecordCodec α} {left right : α}
    (same : codec.canonicalText left = codec.canonicalText right) : left = right := by
  have values : codec.encode left = codec.encode right :=
    Json.canonicalText_injective same
  have decoded := congrArg codec.decode values
  rw [decode_encode, decode_encode] at decoded
  exact Except.ok.inj decoded

/-- **A record written under an unknown major is refused, not read.** -/
theorem decode_unknown_major {codec : RecordCodec α} {envelope : Envelope}
    (kind : envelope.kind = codec.kind)
    (differs : envelope.version.major ≠ codec.version.major) :
    (codec.decode envelope.toJson).RefusedWith .codecUnknownMajor := by
  unfold decode
  rw [Envelope.ofJson_toJson]
  simp [kind, versionRefusal_unknown_major differs, refuse, Outcome.RefusedWith]

/-- **A record written under a newer minor of a known major is refused as `codec.invalid`.** -/
theorem decode_newer_minor {codec : RecordCodec α} {envelope : Envelope}
    (kind : envelope.kind = codec.kind)
    (same : envelope.version.major = codec.version.major)
    (newer : codec.version.minor < envelope.version.minor) :
    (codec.decode envelope.toJson).RefusedWith .codecInvalid := by
  unfold decode
  rw [Envelope.ofJson_toJson]
  simp [kind, versionRefusal_newer_minor same newer, refuse, Outcome.RefusedWith]

/-- **A record of another kind is refused.** A codec never decodes a payload it was not
written for, whatever that payload happens to contain. -/
theorem decode_foreign_kind {codec : RecordCodec α} {envelope : Envelope}
    (foreign : envelope.kind ≠ codec.kind) :
    (codec.decode envelope.toJson).RefusedWith .codecInvalid := by
  unfold decode
  rw [Envelope.ofJson_toJson]
  simp [foreign, refuse, Outcome.RefusedWith]

/-- **An older minor of the same major is read through the payload reader.** Tolerant read
is not a separate path: the same reader serves it. -/
theorem decode_tolerates_older_minor {codec : RecordCodec α} {envelope : Envelope}
    (kind : envelope.kind = codec.kind)
    (same : envelope.version.major = codec.version.major)
    (older : envelope.version.minor ≤ codec.version.minor) :
    codec.decode envelope.toJson =
      (codec.decodePayload envelope.payload).mapError throughCodec := by
  unfold decode
  rw [Envelope.ofJson_toJson]
  simp only [kind, beq_self_eq_true, if_true, versionRefusal_tolerant same older]
  cases codec.decodePayload envelope.payload <;> rfl

/-- **A malformed envelope is refused as `codec.invalid`.** -/
theorem decode_malformed {codec : RecordCodec α} {value : Json.JsonValue} {fault : Fault}
    (malformed : Envelope.ofJson value = .error fault) :
    codec.decode value = .error fault := by
  unfold decode
  rw [malformed]

end RecordCodec

/-! ## Record-set declarations

`CodecDeclaration` is the versions an Actor's stored records were written under. A reader
reaches it before decoding anything, and the verdict is total: compatible, a kind the reader
does not declare, or a version its own codec refuses. -/

/-- One kind and the version its records were written under. -/
structure DeclaredCodecVersion where
  kind : String
  version : RecordVersion
  deriving DecidableEq, Repr

/-- The version a declaration records for a kind. -/
def declaredVersionOf : List DeclaredCodecVersion → String → Option RecordVersion
  | [], _ => none
  | entry :: rest, kind => if entry.kind = kind then some entry.version
      else declaredVersionOf rest kind

/-- The verdict a reader reaches about a stored set, refusing at the first kind it cannot
serve. `none` is compatible. -/
def declarationRefusal : List DeclaredCodecVersion → List DeclaredCodecVersion →
    Option ErrorCode
  | [], _ => none
  | entry :: rest, reader =>
      match declaredVersionOf reader entry.kind with
      | none => some .schemaUnreadable
      | some supported =>
          match versionRefusal entry.version supported with
          | some code => some code
          | none => declarationRefusal rest reader

/-- **A kind the reader does not declare is `schema.unreadable`.** The set is left exactly
as stored: no record of it is decoded, so no derivation can answer from the readable part. -/
theorem declarationRefusal_undeclared {entry : DeclaredCodecVersion}
    {stored reader : List DeclaredCodecVersion}
    (undeclared : declaredVersionOf reader entry.kind = none) :
    declarationRefusal (entry :: stored) reader = some .schemaUnreadable := by
  simp [declarationRefusal, undeclared]

/-- **A record set and a single record never disagree.** Where the reader declares the kind,
the set-level verdict is exactly the refusal that kind's own codec would earn. -/
theorem declarationRefusal_matches_record {entry : DeclaredCodecVersion}
    {stored reader : List DeclaredCodecVersion} {supported : RecordVersion} {code : ErrorCode}
    (declared : declaredVersionOf reader entry.kind = some supported)
    (refused : versionRefusal entry.version supported = some code) :
    declarationRefusal (entry :: stored) reader = some code := by
  simp [declarationRefusal, declared, refused]

/-- **The verdict is total.** Every stored declaration either reads or names one refusal;
there is no third answer and no undecided input. -/
theorem declarationRefusal_total (stored reader : List DeclaredCodecVersion) :
    declarationRefusal stored reader = none ∨
      ∃ code, declarationRefusal stored reader = some code := by
  by_cases empty : declarationRefusal stored reader = none
  · exact .inl empty
  · refine .inr ?_
    cases shape : declarationRefusal stored reader with
    | none => exact absurd shape empty
    | some code => exact ⟨code, rfl⟩

end AgentCore.Kernel
