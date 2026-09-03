import SpecCnl.Intent.Elab
import SpecCnl.Sentences

/-!
# What discharges every intent verdict

One claim and one proof per record, plus the bridge that keeps the two languages from
drifting. Nothing here is written beside a record: the denotation, the polarity split and
the verdict claim are all `SpecCnl.Intent.Elab`'s output for that record's key, so a proof
cannot be a proof of something else and a record cannot claim a verdict about a sentence it
does not have.

Read what each declaration is worth.

* `intent_X` is the record's sentence as a predicate on relations. `split_X` is the same
  reading split by polarity, and `splits_X` is the kernel-checked statement that the two
  agree. Without `splits_X` the checker would be reasoning about a set of atoms nobody
  proved was this sentence's.
* `upward_X` names the polarity theorem of each permission. `sat_iff_rmax` takes it as a
  hypothesis, so a connective whose polarity were only declared could not be used.
* `witnessed_X` exhibits one transition per permission inside `rmax step safety`. It goes
  through `leaseStepExec_sound`, so the executable mirror the search used is the same
  mirror the proof rests on.
* `refuted_X` refutes one permission universally, at the 1-minimal core the search found.
* `verdict_X` inhabits `claim_X`, and `claim_X` is generated from the record's own expected
  verdict and its ledger's step relation. This is the declaration whose type the report
  shape-checks, so it is where a verdict either means what the record says or fails.
* `bridge_A` proves the intent atom instantiated at the model is exactly the controlled
  language's own sentence for the same rule. The 88 corpus units need no rewrite and the
  two languages cannot drift apart: one lemma fails the build if they do.

No verdict here rests on the bounded search. INCONSISTENT and OUTSIDE-MODEL each rest on a
universal refutation, and CONSISTENT rests on an exhibited transition, which is a proof of
an existential and needs no bound at all.
-/

namespace SpecCnl.Intent.Proofs

open AgentCore SpecCnl.Intent

/-! ## Shapes stage 1 uses

Every stage-1 record is one safety atom and one permission, so the list bookkeeping happens
once here rather than four times below. Each lemma takes the split's shape as two equations
the caller closes by `rfl`, which is what keeps the atom and the permission the *elaborator's*
terms rather than retyped ones. A record with two permissions needs the general form, and
these lemmas are where it would go. -/

/-- `rmax` over one safety atom, with the list eliminated. -/
theorem rmax_one {σ lab : Type} (bound : Lts σ lab) (atom : Guarded σ lab) :
    rmax bound [atom] = fun before label after =>
      bound before label after ∧ atom.holds before label := by
  funext before label after
  simp [rmax]

/-- The one permission of a one-and-one split is in its permission list. -/
theorem mem_one {σ lab : Type} {split : Split σ lab} {permission : Lts σ lab → Prop}
    (isPermission : split.permissions = [permission]) : permission ∈ split.permissions := by
  rw [isPermission]
  simp

/-- A one-and-one split says exactly what its two atoms say. -/
theorem denote_one {σ lab : Type} {split : Split σ lab} {atom : Guarded σ lab}
    {permission : Lts σ lab → Prop} (isSafety : split.safety = [atom])
    (isPermission : split.permissions = [permission]) (R : Lts σ lab) :
    split.denote R ↔ (inRequires atom.cond atom.guard R ∧ permission R) := by
  unfold Split.denote Pointwise
  rw [isSafety, isPermission]
  constructor
  · rintro ⟨pointwise, permitted⟩
    refine ⟨fun before label after step selected => ?_, permitted permission (by simp)⟩
    exact pointwise before label after step atom (by simp) selected
  · rintro ⟨safe, permitted⟩
    refine ⟨fun before label after step other member => ?_, fun other member => ?_⟩
    · have same : other = atom := by simpa using member
      exact same ▸ fun selected => safe before label after step selected
    · have same : other = permission := by simpa using member
      exact same ▸ permitted

/-- Upward closure of the one permission is upward closure of every permission. -/
theorem upward_one {σ lab : Type} {split : Split σ lab} {permission : Lts σ lab → Prop}
    (isPermission : split.permissions = [permission]) (upward : Upward permission) :
    ∀ candidate ∈ split.permissions, Upward candidate := by
  intro candidate member
  rw [isPermission] at member
  have same : candidate = permission := by simpa using member
  exact same ▸ upward

/-- One witness inside `rmax bound [atom]` is a witness for every permission. -/
theorem holds_one {σ lab : Type} {split : Split σ lab} {atom : Guarded σ lab}
    {permission : Lts σ lab → Prop} (bound : Lts σ lab) (isSafety : split.safety = [atom])
    (isPermission : split.permissions = [permission])
    (holds : permission (fun before label after =>
      bound before label after ∧ atom.holds before label)) :
    ∀ candidate ∈ split.permissions, candidate (rmax bound split.safety) := by
  intro candidate member
  rw [isPermission] at member
  have same : candidate = permission := by simpa using member
  rw [isSafety, rmax_one]
  exact same ▸ holds

/-- One refutation refutes every permission, when there is one permission. -/
theorem fails_one {σ lab : Type} {split : Split σ lab} {atom : Guarded σ lab}
    {permission : Lts σ lab → Prop} (bound : Lts σ lab) (isSafety : split.safety = [atom])
    (isPermission : split.permissions = [permission])
    (fails : ¬ permission (fun before label after =>
      bound before label after ∧ atom.holds before label)) :
    ∀ candidate ∈ split.permissions, ¬ candidate (rmax bound split.safety) := by
  intro candidate member
  rw [isPermission] at member
  have same : candidate = permission := by simpa using member
  rw [isSafety, rmax_one]
  exact same ▸ fails

/-! ## The atoms and their polarity

Each atom's declared polarity is proved of its denotation here, so the polarity the checker
splits by is the polarity the connective really has. -/

def intent_LEASE_EXPIRY_BOUND : Lts TurnLease LeaseLabel → Prop :=
  intent% "LEASE_EXPIRY_BOUND"

theorem polar_LEASE_EXPIRY_BOUND : Downward intent_LEASE_EXPIRY_BOUND :=
  inRequires_downward _ _

def intent_LEASE_RECLAIM_POSSIBLE : Lts TurnLease LeaseLabel → Prop :=
  intent% "LEASE_RECLAIM_POSSIBLE"

theorem polar_LEASE_RECLAIM_POSSIBLE : Upward intent_LEASE_RECLAIM_POSSIBLE :=
  inPossible_upward _

def intent_LEASE_RECLAIM_UNHELD : Lts TurnLease LeaseLabel → Prop :=
  intent% "LEASE_RECLAIM_UNHELD"

theorem polar_LEASE_RECLAIM_UNHELD : Downward intent_LEASE_RECLAIM_UNHELD :=
  inRequires_downward _ _

def intent_LEASE_RECLAIM_BY_TWO : Lts TurnLease LeaseLabel → Prop :=
  intent% "LEASE_RECLAIM_BY_TWO"

theorem polar_LEASE_RECLAIM_BY_TWO : Downward intent_LEASE_RECLAIM_BY_TWO :=
  inRequires_downward _ _

def intent_LEASE_RECLAIM_AT_THREE : Lts TurnLease LeaseLabel → Prop :=
  intent% "LEASE_RECLAIM_AT_THREE"

theorem polar_LEASE_RECLAIM_AT_THREE : Upward intent_LEASE_RECLAIM_AT_THREE :=
  inPossibleWhere_upward _ _

/-! ## The bridge to the controlled language

`C13-TURN-LEASE-EXPIRY` is in the reviewed corpus as a sentence about the model's own step
relation. The same requirement is `LEASE_EXPIRY_BOUND` here, as a constraint on a platform.
Instantiated at the step relation the two are the same statement, and this is the lemma that
says so. It is the reason 88 corpus units need no rewrite: a lexicon edit that changed
either side fails here. -/

def atModel_LEASE_EXPIRY_BOUND : Prop := intent_at_model% "LEASE_EXPIRY_BOUND"

theorem bridge_LEASE_EXPIRY_BOUND :
    atModel_LEASE_EXPIRY_BOUND ↔ Sentences.cnl_C13_TURN_LEASE_EXPIRY := by
  unfold atModel_LEASE_EXPIRY_BOUND Sentences.cnl_C13_TURN_LEASE_EXPIRY atModel
  constructor
  · rintro claim before label after ⟨matched, step⟩
    exact claim before label after step matched
  · intro claim before label after step matched
    exact claim before label after ⟨matched, step⟩

/-! ## The witness transition

An expired held lease reclaimed at the tick its lease expired. `leaseStepExec_sound` is what
turns the mirror's answer into a step of the relation, which is exactly how the differential
oracle's answers carry the relation's meaning. -/

def witnessLease : TurnLease := ⟨⟨0⟩, some ⟨⟨0⟩, ⟨0⟩⟩, 0, ⟨1⟩⟩

def witnessLabel : LeaseLabel := .reclaim ⟨⟨0⟩, ⟨0⟩⟩ ⟨1⟩ ⟨2⟩

def witnessAfter : TurnLease := ⟨⟨0⟩, some ⟨⟨0⟩, ⟨0⟩⟩, 1, ⟨2⟩⟩

theorem witnessStep : LeaseStep witnessLease witnessLabel witnessAfter :=
  leaseStepExec_sound (by decide)

/-- The same reclaim from a lease nobody holds. The SPEC model admits no such step, which is
the whole point: a witness under the universe and a refutation target under the model. -/
def unheldLease : TurnLease := ⟨⟨0⟩, none, 0, ⟨1⟩⟩

/-- The stated time of the witness label is the tick the witness lease expired at, so both
records whose safety atom bounds that time accept it. -/
private theorem witnessStatedTime (holder : PrincipalRef) (now ends : Time)
    (equal : witnessLabel = .reclaim holder now ends) : now = ⟨1⟩ := by
  simp only [witnessLabel, LeaseLabel.reclaim.injEq] at equal
  exact equal.2.1.symm

/-! ## `INT_LEASE_RECLAIM` — CONSISTENT -/

def intent_INT_LEASE_RECLAIM : Lts TurnLease LeaseLabel → Prop := intent% "INT_LEASE_RECLAIM"

def split_INT_LEASE_RECLAIM : Split TurnLease LeaseLabel := intent_split% "INT_LEASE_RECLAIM"

theorem splits_INT_LEASE_RECLAIM :
    ∀ R, intent_INT_LEASE_RECLAIM R ↔ split_INT_LEASE_RECLAIM.denote R :=
  fun R => (denote_one (split := split_INT_LEASE_RECLAIM) rfl rfl R).symm

theorem upward_INT_LEASE_RECLAIM :
    ∀ candidate ∈ split_INT_LEASE_RECLAIM.permissions, Upward candidate :=
  upward_one (split := split_INT_LEASE_RECLAIM) rfl (inPossible_upward _)

theorem witnessed_INT_LEASE_RECLAIM :
    ∀ candidate ∈ split_INT_LEASE_RECLAIM.permissions,
      candidate (rmax LeaseStep split_INT_LEASE_RECLAIM.safety) := by
  refine holds_one (split := split_INT_LEASE_RECLAIM) LeaseStep rfl rfl
    ⟨witnessLease, witnessLabel, witnessAfter, ⟨witnessStep, ?_⟩, ⟨_, _, _, rfl⟩⟩
  intro _ holder now ends equal
  rw [witnessStatedTime holder now ends equal]
  simp only [nuAtMost]
  decide

def claim_INT_LEASE_RECLAIM : Prop := intent_claim% "INT_LEASE_RECLAIM"

theorem verdict_INT_LEASE_RECLAIM : claim_INT_LEASE_RECLAIM :=
  (satAt_congr LeaseStep splits_INT_LEASE_RECLAIM).mpr
    ((sat_iff_rmax LeaseStep split_INT_LEASE_RECLAIM upward_INT_LEASE_RECLAIM).mpr
      witnessed_INT_LEASE_RECLAIM)

/-! ## `INT_ADV_BOUNDED_RECLAIM` — CONSISTENT

The discriminating case: a safety atom that bounds a permission does not contradict it. -/

def intent_INT_ADV_BOUNDED_RECLAIM : Lts TurnLease LeaseLabel → Prop :=
  intent% "INT_ADV_BOUNDED_RECLAIM"

def split_INT_ADV_BOUNDED_RECLAIM : Split TurnLease LeaseLabel :=
  intent_split% "INT_ADV_BOUNDED_RECLAIM"

theorem splits_INT_ADV_BOUNDED_RECLAIM :
    ∀ R, intent_INT_ADV_BOUNDED_RECLAIM R ↔ split_INT_ADV_BOUNDED_RECLAIM.denote R :=
  fun R => Iff.trans And.comm (denote_one (split := split_INT_ADV_BOUNDED_RECLAIM) rfl rfl R).symm

theorem upward_INT_ADV_BOUNDED_RECLAIM :
    ∀ candidate ∈ split_INT_ADV_BOUNDED_RECLAIM.permissions, Upward candidate :=
  upward_one (split := split_INT_ADV_BOUNDED_RECLAIM) rfl (inPossible_upward _)

theorem witnessed_INT_ADV_BOUNDED_RECLAIM :
    ∀ candidate ∈ split_INT_ADV_BOUNDED_RECLAIM.permissions,
      candidate (rmax LeaseStep split_INT_ADV_BOUNDED_RECLAIM.safety) := by
  refine holds_one (split := split_INT_ADV_BOUNDED_RECLAIM) LeaseStep rfl rfl
    ⟨witnessLease, witnessLabel, witnessAfter, ⟨witnessStep, ?_⟩, ⟨_, _, _, rfl⟩⟩
  intro _ holder now ends equal
  rw [witnessStatedTime holder now ends equal]
  simp only [nuAtMost, nuLiteral]
  decide

def claim_INT_ADV_BOUNDED_RECLAIM : Prop := intent_claim% "INT_ADV_BOUNDED_RECLAIM"

theorem verdict_INT_ADV_BOUNDED_RECLAIM : claim_INT_ADV_BOUNDED_RECLAIM :=
  (satAt_congr LeaseStep splits_INT_ADV_BOUNDED_RECLAIM).mpr
    ((sat_iff_rmax LeaseStep split_INT_ADV_BOUNDED_RECLAIM upward_INT_ADV_BOUNDED_RECLAIM).mpr
      witnessed_INT_ADV_BOUNDED_RECLAIM)

/-! ## `INT_ADV_EARLY_LATE_RECLAIM` — INCONSISTENT

No platform at all satisfies both atoms, so the refutation is arithmetic and never mentions
the model. -/

def intent_INT_ADV_EARLY_LATE_RECLAIM : Lts TurnLease LeaseLabel → Prop :=
  intent% "INT_ADV_EARLY_LATE_RECLAIM"

def split_INT_ADV_EARLY_LATE_RECLAIM : Split TurnLease LeaseLabel :=
  intent_split% "INT_ADV_EARLY_LATE_RECLAIM"

theorem splits_INT_ADV_EARLY_LATE_RECLAIM :
    ∀ R, intent_INT_ADV_EARLY_LATE_RECLAIM R ↔ split_INT_ADV_EARLY_LATE_RECLAIM.denote R :=
  fun R => (denote_one (split := split_INT_ADV_EARLY_LATE_RECLAIM) rfl rfl R).symm

theorem upward_INT_ADV_EARLY_LATE_RECLAIM :
    ∀ candidate ∈ split_INT_ADV_EARLY_LATE_RECLAIM.permissions, Upward candidate :=
  upward_one (split := split_INT_ADV_EARLY_LATE_RECLAIM) rfl (inPossibleWhere_upward _ _)

theorem refuted_INT_ADV_EARLY_LATE_RECLAIM :
    ∀ candidate ∈ split_INT_ADV_EARLY_LATE_RECLAIM.permissions,
      ¬ candidate (rmax anyTransition split_INT_ADV_EARLY_LATE_RECLAIM.safety) := by
  refine fails_one (split := split_INT_ADV_EARLY_LATE_RECLAIM) anyTransition rfl rfl ?_
  rintro ⟨before, label, after, ⟨_, safe⟩, selected, satisfied⟩
  obtain ⟨holder, now, ends, rfl⟩ := selected
  have atMostTwo := safe ⟨holder, now, ends, rfl⟩ holder now ends rfl
  have equalsThree := satisfied holder now ends rfl
  simp only [nuAtMost, nuEquals, nuLiteral] at atMostTwo equalsThree
  omega

def claim_INT_ADV_EARLY_LATE_RECLAIM : Prop := intent_claim% "INT_ADV_EARLY_LATE_RECLAIM"

theorem verdict_INT_ADV_EARLY_LATE_RECLAIM : claim_INT_ADV_EARLY_LATE_RECLAIM := by
  intro satisfiable
  have permitted :=
    (sat_iff_rmax anyTransition split_INT_ADV_EARLY_LATE_RECLAIM
        upward_INT_ADV_EARLY_LATE_RECLAIM).mp
      ((satAt_congr anyTransition splits_INT_ADV_EARLY_LATE_RECLAIM).mp satisfiable)
  exact refuted_INT_ADV_EARLY_LATE_RECLAIM _
    (mem_one (split := split_INT_ADV_EARLY_LATE_RECLAIM) rfl)
    (permitted _ (mem_one (split := split_INT_ADV_EARLY_LATE_RECLAIM) rfl))

/-! ## `INT_ADV_UNHELD_RECLAIM` — OUTSIDE-MODEL

Nothing contradicts anything: a platform that reclaims leases nobody holds is conceivable,
and the universe half witnesses one. The SPEC model is what refuses it, because
`LeaseStep.reclaim` demands a holder, so the refutation is an inversion on that
constructor. -/

def intent_INT_ADV_UNHELD_RECLAIM : Lts TurnLease LeaseLabel → Prop :=
  intent% "INT_ADV_UNHELD_RECLAIM"

def split_INT_ADV_UNHELD_RECLAIM : Split TurnLease LeaseLabel :=
  intent_split% "INT_ADV_UNHELD_RECLAIM"

theorem splits_INT_ADV_UNHELD_RECLAIM :
    ∀ R, intent_INT_ADV_UNHELD_RECLAIM R ↔ split_INT_ADV_UNHELD_RECLAIM.denote R :=
  fun R => Iff.trans And.comm (denote_one (split := split_INT_ADV_UNHELD_RECLAIM) rfl rfl R).symm

theorem upward_INT_ADV_UNHELD_RECLAIM :
    ∀ candidate ∈ split_INT_ADV_UNHELD_RECLAIM.permissions, Upward candidate :=
  upward_one (split := split_INT_ADV_UNHELD_RECLAIM) rfl (inPossible_upward _)

theorem witnessed_INT_ADV_UNHELD_RECLAIM :
    ∀ candidate ∈ split_INT_ADV_UNHELD_RECLAIM.permissions,
      candidate (rmax anyTransition split_INT_ADV_UNHELD_RECLAIM.safety) := by
  refine holds_one (split := split_INT_ADV_UNHELD_RECLAIM) anyTransition rfl rfl
    ⟨unheldLease, witnessLabel, unheldLease, ⟨trivial, ?_⟩, ⟨_, _, _, rfl⟩⟩
  intro _
  rfl

theorem refuted_INT_ADV_UNHELD_RECLAIM :
    ∀ candidate ∈ split_INT_ADV_UNHELD_RECLAIM.permissions,
      ¬ candidate (rmax LeaseStep split_INT_ADV_UNHELD_RECLAIM.safety) := by
  refine fails_one (split := split_INT_ADV_UNHELD_RECLAIM) LeaseStep rfl rfl ?_
  rintro ⟨before, label, after, ⟨step, safe⟩, selected⟩
  obtain ⟨holder, now, ends, rfl⟩ := selected
  have unheld := safe ⟨holder, now, ends, rfl⟩
  cases step with
  | reclaim held _ _ =>
      rw [unheld] at held
      exact absurd held (by simp)

def claim_INT_ADV_UNHELD_RECLAIM : Prop := intent_claim% "INT_ADV_UNHELD_RECLAIM"

theorem verdict_INT_ADV_UNHELD_RECLAIM : claim_INT_ADV_UNHELD_RECLAIM := by
  refine ⟨?_, ?_⟩
  · exact (satAt_congr anyTransition splits_INT_ADV_UNHELD_RECLAIM).mpr
      ((sat_iff_rmax anyTransition split_INT_ADV_UNHELD_RECLAIM
          upward_INT_ADV_UNHELD_RECLAIM).mpr witnessed_INT_ADV_UNHELD_RECLAIM)
  · intro satisfiable
    have permitted :=
      (sat_iff_rmax LeaseStep split_INT_ADV_UNHELD_RECLAIM upward_INT_ADV_UNHELD_RECLAIM).mp
        ((satAt_congr LeaseStep splits_INT_ADV_UNHELD_RECLAIM).mp satisfiable)
    exact refuted_INT_ADV_UNHELD_RECLAIM _
      (mem_one (split := split_INT_ADV_UNHELD_RECLAIM) rfl)
      (permitted _ (mem_one (split := split_INT_ADV_UNHELD_RECLAIM) rfl))

end SpecCnl.Intent.Proofs
