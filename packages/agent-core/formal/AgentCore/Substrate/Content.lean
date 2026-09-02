import AgentCore.Substrate.Effect

/-!
# Content-addressed bytes

SPEC §8.2 gives the ContentStore three operations — `put`, `get` with an optional range,
and `stat` — and two rules: every `ContentRef` resolves through a store that belongs to
exactly one Tenant (`C13-CONTENT-RESOLUTION`), and every record naming a ref retains that
content until the record releases it (`C13-CONTENT-CUSTODY`). On the Cloudflare profile the
store is R2 with the local store for small content, content-addressed (§10.1).

The seam here is the four host calls a kernel makes — `host.content.put`, `.get`, `.head`,
`.range` — and the equations that make a digest mean something.

## Content addressing is a law, not a naming convention

`put_is_content_addressed` says a put answers with the digest of exactly the bytes it was
given, and `get_verifies` says any bytes a get returns hash to the digest that was asked
for. Together they make a ref an *assertion about content* rather than a key someone chose:
a store that returns the wrong object cannot satisfy the pair, and a corrupted object must
be refused rather than served, because serving it would violate `get_verifies` while
refusing it only fails to answer.

What those two laws do *not* give you is that a ref names one object. Two distinct byte
strings with one digest satisfy both laws happily. That gap is
`Premise.contentDigestCollisionResistant`, and `content_read_is_determined` is where it
appears: the theorem takes digest injectivity as an explicit parameter, so a reader can see
exactly which conclusion rests on the collision assumption and what remains without it.

## Retention is a premise, and deliberately so

There is no `host.content.delete`. Collection is Tenant retention policy over content no
declared retainer owns (§8.2), not a call the kernel makes, so nothing in this interface
can delete an object — and nothing in this interface can *promise* that no one else will
either. `Premise.contentRetentionUntilReleased` is that promise, discharged by
`C13-CONTENT-CUSTODY` evidence rather than by an equation here. What the laws do give is
the half that is checkable: a put never disturbs another object, and reads are queries.

`Premise.contentBucketIsTenantOwned` is the other unstatable half: this interface has no
Tenant in it, by design — a kernel that must not read another Tenant's bytes is holding a
seam bound to its own Tenant's store, and which store a binding names is provenance
evidence, not an equation.
-/

namespace AgentCore.Substrate

/-- The content requests a kernel can issue: wire tails of `Opcode.contentPut`,
`Opcode.contentGet`, `Opcode.contentHead`, `Opcode.contentRange`. -/
inductive ContentOp where
  | put (payload : ByteArray)
  | get (requested : ByteArray)
  | head (requested : ByteArray)
  | range (requested : ByteArray) (offset length : Nat)
  deriving DecidableEq

/-- Which opcode a content request is. -/
def ContentOp.opcode : ContentOp → Opcode
  | .put _ => .contentPut
  | .get _ => .contentGet
  | .head _ => .contentHead
  | .range _ _ _ => .contentRange

/-- Every content request lands on the content seam. -/
theorem ContentOp.opcode_seam (op : ContentOp) : op.opcode.seam = .content := by
  cases op <;> rfl

/-- What the content store can answer. -/
inductive ContentReply where
  | stored (digest : ByteArray)
  | bytes (payload : ByteArray)
  | stat (size : Nat) (digest : ByteArray)
  | absent
  | refused (refusal : Refusal)
  deriving DecidableEq

/-- The content interface, synchronous store-passing over an explicit `σ`. -/
structure ContentEffect (σ : Type) where
  put : ByteArray → σ → ContentReply × σ
  get : ByteArray → σ → ContentReply × σ
  head : ByteArray → σ → ContentReply × σ
  range : ByteArray → Nat → Nat → σ → ContentReply × σ

/-- An object is present when reading its digest answers bytes. -/
def ContentEffect.Present {σ : Type} (effect : ContentEffect σ) (state : σ)
    (requested : ByteArray) : Prop :=
  ∃ payload, (effect.get requested state).1 = .bytes payload

/--
The content laws.

`digest` is the digest function both sides compute; it is a parameter rather than a field
because the kernel must be able to compute a ref without calling the host, which is the
whole point of content addressing. `bound` is the largest object this seam accepts.
-/
structure ContentLaws {σ : Type} (effect : ContentEffect σ)
    (digest : ByteArray → ByteArray) (bound : Nat) : Prop where
  /-- Reads are queries. -/
  get_is_pure : ∀ requested state, (effect.get requested state).2 = state
  /-- Stats are queries. -/
  head_is_pure : ∀ requested state, (effect.head requested state).2 = state
  /-- Range reads are queries. -/
  range_is_pure : ∀ requested offset length state,
    (effect.range requested offset length state).2 = state
  /-- A put answers with the digest of exactly the bytes it stored. -/
  put_is_content_addressed : ∀ payload state, payload.size ≤ bound →
    (effect.put payload state).1 = .stored (digest payload)
  /-- An over-bound object is refused with the state untouched. -/
  put_refuses_over_limit : ∀ payload state, bound < payload.size →
    effect.put payload state = (.refused .overLimit, state)
  /-- What was put can be read back under its digest. -/
  put_get : ∀ payload state, payload.size ≤ bound →
    (effect.get (digest payload) (effect.put payload state).2).1 = .bytes payload
  /-- A put disturbs no other object. -/
  put_preserves_other_objects : ∀ payload requested state, requested ≠ digest payload →
    (effect.get requested (effect.put payload state).2).1 = (effect.get requested state).1
  /-- Any bytes a get returns hash to the digest that was asked for. A store that cannot
  honour this refuses; it does not serve the wrong object. -/
  get_verifies : ∀ requested state payload, (effect.get requested state).1 = .bytes payload →
    digest payload = requested
  /-- A get answers with bytes, with `absent`, or with a refusal, and nothing else. It never
  answers with a `stored` digest or a `stat`: a read is a read. -/
  get_is_total : ∀ requested state,
    (effect.get requested state).1 = .absent ∨
      (∃ refusal, (effect.get requested state).1 = .refused refusal) ∨
      ∃ payload, (effect.get requested state).1 = .bytes payload
  /-- A read of an object past the seam's bound is refused before its bytes cross the
  boundary, and the state is untouched. The stored size is known from the object's own
  metadata, so the refusal costs no transfer — which is why
  `cloudflare/src/content-object.ts#R2ContentObjectRepository` bounds reads as well as
  writes, and why a bound is a property of the seam rather than of one direction. -/
  get_refuses_over_limit : ∀ requested state size,
    (effect.head requested state).1 = .stat size requested → bound < size →
      effect.get requested state = (.refused .overLimit, state)
  /-- A stat over a readable object reports that object's size and digest. -/
  head_reports_size : ∀ requested state payload,
    (effect.get requested state).1 = .bytes payload →
      (effect.head requested state).1 = .stat payload.size requested
  /-- And a reported stat is a readable object's stat: a stat never describes something a
  read cannot produce. -/
  head_is_faithful : ∀ requested state size,
    (effect.head requested state).1 = .stat size requested →
      ∃ payload, (effect.get requested state).1 = .bytes payload ∧ payload.size = size
  /-- A range inside the object is exactly that slice of it. -/
  range_is_a_slice : ∀ requested offset length state payload,
    (effect.get requested state).1 = .bytes payload → offset + length ≤ payload.size →
      (effect.range requested offset length state).1 =
        .bytes (payload.extract offset (offset + length))
  /-- A range outside the object is refused, not clamped: a short read that looks like a
  successful one is how a caller ends up digesting a prefix. -/
  range_refuses_outside : ∀ requested offset length state payload,
    (effect.get requested state).1 = .bytes payload → payload.size < offset + length →
      (effect.range requested offset length state).1 = .refused .outOfRange
  /-- A range read of an object that is not there is `absent`, exactly as a whole read of
  it would be: a partial read cannot conjure an object a full read denies. -/
  range_absent : ∀ requested offset length state,
    (effect.get requested state).1 = .absent →
      (effect.range requested offset length state).1 = .absent
  /-- A range read carries whatever refusal a whole read carries: a corrupted object, an
  over-bound object, or anything else this seam refuses is refused identically through the
  partial path, so no refusal is escapable by asking for less. -/
  range_refuses_when_get_refuses : ∀ requested offset length state refusal,
    (effect.get requested state).1 = .refused refusal →
      (effect.range requested offset length state).1 = .refused refusal

section Addressing

variable {σ : Type} {effect : ContentEffect σ} {digest : ByteArray → ByteArray} {bound : Nat}

/-- A stored object is present under the digest the put returned. -/
theorem put_makes_content_present (laws : ContentLaws effect digest bound)
    (payload : ByteArray) (state : σ) (fits : payload.size ≤ bound) :
    effect.Present (effect.put payload state).2 (digest payload) :=
  ⟨payload, laws.put_get payload state fits⟩

/-- Storing one object never makes another unreadable. Half of retention — the half this
interface can state (`C13-CONTENT-CUSTODY`; the other half is
`Premise.contentRetentionUntilReleased`). -/
theorem put_preserves_presence (laws : ContentLaws effect digest bound)
    {requested : ByteArray} (payload : ByteArray) (state : σ)
    (different : requested ≠ digest payload) (held : effect.Present state requested) :
    effect.Present (effect.put payload state).2 requested := by
  obtain ⟨stored, readable⟩ := held
  exact ⟨stored, by
    rw [laws.put_preserves_other_objects payload requested state different]; exact readable⟩

/-- An over-bound put changes nothing at all, so a caller that guessed wrong about a size
limit has not lost the objects it already had. -/
theorem over_limit_put_preserves_everything (laws : ContentLaws effect digest bound)
    (payload : ByteArray) (state : σ) (oversized : bound < payload.size) :
    (effect.put payload state).2 = state := by
  rw [laws.put_refuses_over_limit payload state oversized]

/--
A ref determines its bytes — *given* digest injectivity, which is
`Premise.contentDigestCollisionResistant` supplied as an explicit parameter.

This is the theorem the collision assumption is for, and stating it this way is the
difference between a premise and a hidden axiom: without `injective` the laws still hold
and this conclusion is simply unavailable. Two reads of one ref, in any two states of the
store, agree.
-/
theorem content_read_is_determined (laws : ContentLaws effect digest bound)
    (injective : ∀ left right : ByteArray, digest left = digest right → left = right)
    {requested : ByteArray} {first second : σ} {early late : ByteArray}
    (readEarly : (effect.get requested first).1 = .bytes early)
    (readLate : (effect.get requested second).1 = .bytes late) : early = late := by
  have earlyDigest : digest early = requested := laws.get_verifies requested first early readEarly
  have lateDigest : digest late = requested := laws.get_verifies requested second late readLate
  exact injective early late (by rw [earlyDigest, lateDigest])

/-- A stat is enough to plan a read: a range inside the reported size answers with bytes
rather than refusing, so a kernel that checks `head` first never has to handle
`outOfRange`. -/
theorem range_inside_stat_reads_bytes (laws : ContentLaws effect digest bound)
    {requested : ByteArray} {state : σ} {size offset length : Nat}
    (statted : (effect.head requested state).1 = .stat size requested)
    (inside : offset + length ≤ size) :
    ∃ slice, (effect.range requested offset length state).1 = .bytes slice := by
  obtain ⟨payload, readable, sized⟩ := laws.head_is_faithful requested state size statted
  refine ⟨payload.extract offset (offset + length), ?_⟩
  exact laws.range_is_a_slice requested offset length state payload readable (by omega)

/-- A range read never invents an object: a slice implies the whole object is readable. -/
theorem range_implies_presence (laws : ContentLaws effect digest bound)
    {requested : ByteArray} {state : σ} {offset length : Nat} {slice : ByteArray}
    (sliced : (effect.range requested offset length state).1 = .bytes slice) :
    effect.Present state requested := by
  rcases laws.get_is_total requested state with absent | ⟨refusal, refused⟩ | ⟨payload, readable⟩
  · rw [laws.range_absent requested offset length state absent] at sliced
    simp at sliced
  · rw [laws.range_refuses_when_get_refuses requested offset length state refusal refused]
      at sliced
    simp at sliced
  · exact ⟨payload, readable⟩

/-- An over-bound object cannot be read whole and cannot be read in pieces either: the
refusal is the seam's, not the transfer's, so a caller cannot walk around it with ranges.
`head` still answers, which is what leaves an operator able to see what is there. -/
theorem over_limit_object_is_unreadable (laws : ContentLaws effect digest bound)
    {requested : ByteArray} {state : σ} {size offset length : Nat}
    (statted : (effect.head requested state).1 = .stat size requested)
    (oversized : bound < size) :
    effect.get requested state = (.refused .overLimit, state) ∧
      (effect.range requested offset length state).1 = .refused .overLimit := by
  have refused := laws.get_refuses_over_limit requested state size statted oversized
  refine ⟨refused, ?_⟩
  exact laws.range_refuses_when_get_refuses requested offset length state .overLimit
    (by rw [refused])

end Addressing

end AgentCore.Substrate
