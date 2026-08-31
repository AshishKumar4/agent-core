import RuntimeAssurance.Assurance

/-!
# What a deployed claim is worth after a premise fails

A claim names its modality and the premises it rests on. Against a premise ledger it stands
in exactly one of three ways, and each answers a different question an operator asks after an
incident.

* `void` — a premise it rests on is refuted. `refutedPremises` names which ones, and every
  name is both in the claim's own support and refuted, so "which assumption failed" is data
  rather than a guess.
* `conditional` — nothing it rests on is refuted, and something it rests on is not
  established. `unestablishedPremises` names those.
* `proved` — every premise it rests on is discharged by durable domain evidence. A claim with
  empty support is in this state against every ledger there is, including one whose every
  premise is refuted (`unconditional_claim_is_proved`). That is "which properties remain
  proved".

The blast radius is exact in both directions. `standing_reads_only_its_support` says a
claim's standing is a function of its own support and nothing else, so refuting a premise
voids the claims resting on it and no others: a fault cannot be talked into voiding
everything, and it cannot be talked out of voiding what it does void.

`safety_survives_progress_refutation` turns the safety/liveness split into a consequence
rather than a convention. A claim whose support holds only safety premises keeps its standing
when every progress premise in the world is refuted. `liveness_is_never_unconditional` is the
other side: a well-formed liveness claim rests on at least one progress premise, so it never
sits at `proved` for free.
-/

namespace RuntimeAssurance

inductive Modality where
  | safety
  | liveness
  deriving DecidableEq, Repr

/-- The claim identity. The value is abstract here. Which plane a claim belongs to — `AC-*`
and `NC-*` for the formal one, `C13-*` and `P11-*` for conformance — is a traceability
question, and routing a claim through the wrong plane is exactly the mistake this model must
not be able to make on the ledger's behalf. -/
structure ClaimId where
  value : Nat
  deriving DecidableEq, Repr

inductive ClaimStanding where
  | proved
  | conditional
  | void
  deriving DecidableEq, Repr

structure Claim where
  id : ClaimId
  modality : Modality
  support : List Premise
  deriving DecidableEq, Repr

/-- A liveness claim rests on at least one progress premise. A predicate on the claim rather
than a constraint in the structure, because a claim that violates it must be representable
for `liveness_is_never_unconditional` to exclude something real. -/
def Claim.WellFormed (self : Claim) : Prop :=
  self.modality = .liveness → ∃ premise ∈ self.support, premise.kind = .progress

def refutedPremises (ledger : Assurance) : List Premise → List Premise
  | [] => []
  | premise :: rest =>
      if ledger.standing premise = .refuted then premise :: refutedPremises ledger rest
      else refutedPremises ledger rest

def unestablishedPremises (ledger : Assurance) : List Premise → List Premise
  | [] => []
  | premise :: rest =>
      if ledger.standing premise = .discharged then unestablishedPremises ledger rest
      else premise :: unestablishedPremises ledger rest

theorem refutedPremises_cons_refuted {ledger : Assurance} {premise : Premise}
    {rest : List Premise} (refuted : ledger.standing premise = .refuted) :
    refutedPremises ledger (premise :: rest) = premise :: refutedPremises ledger rest := by
  simp [refutedPremises, refuted]

theorem refutedPremises_cons_standing {ledger : Assurance} {premise : Premise}
    {rest : List Premise} (standing : ledger.standing premise ≠ .refuted) :
    refutedPremises ledger (premise :: rest) = refutedPremises ledger rest := by
  simp [refutedPremises, standing]

theorem unestablishedPremises_cons_discharged {ledger : Assurance} {premise : Premise}
    {rest : List Premise} (discharged : ledger.standing premise = .discharged) :
    unestablishedPremises ledger (premise :: rest) = unestablishedPremises ledger rest := by
  simp [unestablishedPremises, discharged]

theorem unestablishedPremises_cons_open {ledger : Assurance} {premise : Premise}
    {rest : List Premise} (unestablished : ledger.standing premise ≠ .discharged) :
    unestablishedPremises ledger (premise :: rest) =
      premise :: unestablishedPremises ledger rest := by
  simp [unestablishedPremises, unestablished]

theorem mem_refutedPremises {ledger : Assurance} {premise : Premise} {support : List Premise} :
    premise ∈ refutedPremises ledger support ↔
      premise ∈ support ∧ ledger.standing premise = .refuted := by
  induction support with
  | nil => simp [refutedPremises]
  | cons head rest ih =>
      by_cases refuted : ledger.standing head = .refuted
      · simp only [refutedPremises_cons_refuted refuted, List.mem_cons, ih]
        constructor
        · rintro (rfl | ⟨member, standing⟩)
          · exact ⟨Or.inl rfl, refuted⟩
          · exact ⟨Or.inr member, standing⟩
        · rintro ⟨same | member, standing⟩
          · exact Or.inl same
          · exact Or.inr ⟨member, standing⟩
      · simp only [refutedPremises_cons_standing refuted, ih, List.mem_cons]
        constructor
        · rintro ⟨member, standing⟩
          exact ⟨Or.inr member, standing⟩
        · rintro ⟨rfl | member, standing⟩
          · exact absurd standing refuted
          · exact ⟨member, standing⟩

theorem mem_unestablishedPremises {ledger : Assurance} {premise : Premise}
    {support : List Premise} :
    premise ∈ unestablishedPremises ledger support ↔
      premise ∈ support ∧ ledger.standing premise ≠ .discharged := by
  induction support with
  | nil => simp [unestablishedPremises]
  | cons head rest ih =>
      by_cases discharged : ledger.standing head = .discharged
      · simp only [unestablishedPremises_cons_discharged discharged, ih, List.mem_cons]
        constructor
        · rintro ⟨member, standing⟩
          exact ⟨Or.inr member, standing⟩
        · rintro ⟨rfl | member, standing⟩
          · exact absurd discharged standing
          · exact ⟨member, standing⟩
      · simp only [unestablishedPremises_cons_open discharged, List.mem_cons, ih]
        constructor
        · rintro (rfl | ⟨member, standing⟩)
          · exact ⟨Or.inl rfl, discharged⟩
          · exact ⟨Or.inr member, standing⟩
        · rintro ⟨same | member, standing⟩
          · exact Or.inl same
          · exact Or.inr ⟨member, standing⟩

theorem list_eq_nil_of_no_member {α : Type} {list : List α} (bare : ∀ item, item ∉ list) :
    list = [] := by
  cases list with
  | nil => rfl
  | cons head rest => exact absurd List.mem_cons_self (bare head)

theorem refutedPremises_eq_nil_iff {ledger : Assurance} {support : List Premise} :
    refutedPremises ledger support = [] ↔
      ∀ premise ∈ support, ledger.standing premise ≠ .refuted := by
  constructor
  · intro bare premise member refuted
    have listed : premise ∈ refutedPremises ledger support :=
      mem_refutedPremises.mpr ⟨member, refuted⟩
    rw [bare] at listed
    exact absurd listed List.not_mem_nil
  · intro standing
    refine list_eq_nil_of_no_member ?_
    intro premise listed
    obtain ⟨member, refuted⟩ := mem_refutedPremises.mp listed
    exact standing premise member refuted

theorem unestablishedPremises_eq_nil_iff {ledger : Assurance} {support : List Premise} :
    unestablishedPremises ledger support = [] ↔
      ∀ premise ∈ support, ledger.standing premise = .discharged := by
  constructor
  · intro bare premise member
    refine standing_discharged_of_not_ne ?_
    intro unestablished
    have listed : premise ∈ unestablishedPremises ledger support :=
      mem_unestablishedPremises.mpr ⟨member, unestablished⟩
    rw [bare] at listed
    exact absurd listed List.not_mem_nil
  · intro discharged
    refine list_eq_nil_of_no_member ?_
    intro premise listed
    obtain ⟨member, unestablished⟩ := mem_unestablishedPremises.mp listed
    exact absurd (discharged premise member) unestablished

/-- Refutations first. A claim resting on a refuted premise is void whatever else is
established, which is the precedence `standingOf` applies one level down. -/
def supportStanding (ledger : Assurance) (support : List Premise) : ClaimStanding :=
  match refutedPremises ledger support with
  | _ :: _ => .void
  | [] =>
      match unestablishedPremises ledger support with
      | _ :: _ => .conditional
      | [] => .proved

theorem supportStanding_void_iff {ledger : Assurance} {support : List Premise} :
    supportStanding ledger support = .void ↔ refutedPremises ledger support ≠ [] := by
  cases failed : refutedPremises ledger support with
  | cons head rest => simp [supportStanding, failed]
  | nil =>
      cases unestablished : unestablishedPremises ledger support with
      | cons head rest => simp [supportStanding, failed, unestablished]
      | nil => simp [supportStanding, failed, unestablished]

theorem supportStanding_proved_iff {ledger : Assurance} {support : List Premise} :
    supportStanding ledger support = .proved ↔
      (refutedPremises ledger support = [] ∧ unestablishedPremises ledger support = []) := by
  cases failed : refutedPremises ledger support with
  | cons head rest => simp [supportStanding, failed]
  | nil =>
      cases unestablished : unestablishedPremises ledger support with
      | cons head rest => simp [supportStanding, failed, unestablished]
      | nil => simp [supportStanding, failed, unestablished]

theorem supportStanding_conditional_iff {ledger : Assurance} {support : List Premise} :
    supportStanding ledger support = .conditional ↔
      (refutedPremises ledger support = [] ∧ unestablishedPremises ledger support ≠ []) := by
  cases failed : refutedPremises ledger support with
  | cons head rest => simp [supportStanding, failed]
  | nil =>
      cases unestablished : unestablishedPremises ledger support with
      | cons head rest => simp [supportStanding, failed, unestablished]
      | nil => simp [supportStanding, failed, unestablished]

def Claim.standing (self : Claim) (ledger : Assurance) : ClaimStanding :=
  supportStanding ledger self.support

theorem Claim.standing_eq (self : Claim) (ledger : Assurance) :
    self.standing ledger = supportStanding ledger self.support := rfl

/-! ## The three standings -/

/-- **A void claim rests on a refuted premise, and only such a claim is void.** -/
theorem void_iff_a_premise_is_refuted {self : Claim} {ledger : Assurance} :
    self.standing ledger = .void ↔
      ∃ premise ∈ self.support, ledger.standing premise = .refuted := by
  rw [Claim.standing_eq, supportStanding_void_iff]
  constructor
  · intro nonempty
    cases listed : refutedPremises ledger self.support with
    | nil => exact absurd listed nonempty
    | cons head rest =>
        have member : head ∈ refutedPremises ledger self.support := by
          rw [listed]
          exact List.mem_cons_self
        obtain ⟨inSupport, refuted⟩ := mem_refutedPremises.mp member
        exact ⟨head, inSupport, refuted⟩
  · rintro ⟨premise, member, refuted⟩
    intro bare
    exact absurd refuted (refutedPremises_eq_nil_iff.mp bare premise member)

/-- **A proved claim has every premise discharged, and only such a claim is proved.** -/
theorem proved_iff_every_premise_is_discharged {self : Claim} {ledger : Assurance} :
    self.standing ledger = .proved ↔
      ∀ premise ∈ self.support, ledger.standing premise = .discharged := by
  rw [Claim.standing_eq, supportStanding_proved_iff]
  constructor
  · rintro ⟨_, established⟩
    exact unestablishedPremises_eq_nil_iff.mp established
  · intro discharged
    refine ⟨refutedPremises_eq_nil_iff.mpr ?_, unestablishedPremises_eq_nil_iff.mpr discharged⟩
    intro premise member refuted
    exact absurd ((discharged premise member).symm.trans refuted) (by simp)

/-- **A conditional claim rests on nothing refuted and something unestablished.** -/
theorem conditional_iff_open_but_unrefuted {self : Claim} {ledger : Assurance} :
    self.standing ledger = .conditional ↔
      ((∀ premise ∈ self.support, ledger.standing premise ≠ .refuted) ∧
        ∃ premise ∈ self.support, ledger.standing premise ≠ .discharged) := by
  rw [Claim.standing_eq, supportStanding_conditional_iff]
  constructor
  · rintro ⟨bare, nonempty⟩
    refine ⟨refutedPremises_eq_nil_iff.mp bare, ?_⟩
    cases listed : unestablishedPremises ledger self.support with
    | nil => exact absurd listed nonempty
    | cons head rest =>
        have member : head ∈ unestablishedPremises ledger self.support := by
          rw [listed]
          exact List.mem_cons_self
        obtain ⟨inSupport, unestablished⟩ := mem_unestablishedPremises.mp member
        exact ⟨head, inSupport, unestablished⟩
  · rintro ⟨standing, premise, member, unestablished⟩
    refine ⟨refutedPremises_eq_nil_iff.mpr standing, ?_⟩
    intro bare
    exact absurd (unestablishedPremises_eq_nil_iff.mp bare premise member) unestablished

/-- **An unconditional claim is proved against every ledger.** Not against a good ledger, not
against a monitored one — against every ledger there is, including one whose every premise is
refuted. This is what "which properties remain proved" is asking for. -/
theorem unconditional_claim_is_proved {self : Claim} (ledger : Assurance)
    (unconditional : self.support = []) : self.standing ledger = .proved := by
  rw [Claim.standing_eq, unconditional]
  simp [supportStanding, refutedPremises, unestablishedPremises]

/-- **A named failure is in the claim's own support and is refuted.** The attribution cannot
drift wider than the claim or narrower than the evidence. -/
theorem failed_premise_is_supported_and_refuted {self : Claim} {ledger : Assurance}
    {premise : Premise} (failed : premise ∈ refutedPremises ledger self.support) :
    premise ∈ self.support ∧ ledger.standing premise = .refuted :=
  mem_refutedPremises.mp failed

theorem void_claim_names_a_failure {self : Claim} {ledger : Assurance}
    (void : self.standing ledger = .void) : refutedPremises ledger self.support ≠ [] :=
  supportStanding_void_iff.mp void

/-! ## The blast radius -/

theorem refutedPremises_congr {left right : Assurance} {support : List Premise}
    (agree : ∀ premise ∈ support, left.standing premise = right.standing premise) :
    refutedPremises left support = refutedPremises right support := by
  induction support with
  | nil => rfl
  | cons head rest ih =>
      have headAgrees : left.standing head = right.standing head :=
        agree head List.mem_cons_self
      have tailAgrees := ih fun premise member =>
        agree premise (List.mem_cons.mpr (Or.inr member))
      by_cases refuted : left.standing head = .refuted
      · rw [refutedPremises_cons_refuted refuted,
          refutedPremises_cons_refuted (headAgrees.symm.trans refuted), tailAgrees]
      · rw [refutedPremises_cons_standing refuted,
          refutedPremises_cons_standing (fun other => refuted (headAgrees.trans other)),
          tailAgrees]

theorem unestablishedPremises_congr {left right : Assurance} {support : List Premise}
    (agree : ∀ premise ∈ support, left.standing premise = right.standing premise) :
    unestablishedPremises left support = unestablishedPremises right support := by
  induction support with
  | nil => rfl
  | cons head rest ih =>
      have headAgrees : left.standing head = right.standing head :=
        agree head List.mem_cons_self
      have tailAgrees := ih fun premise member =>
        agree premise (List.mem_cons.mpr (Or.inr member))
      by_cases discharged : left.standing head = .discharged
      · rw [unestablishedPremises_cons_discharged discharged,
          unestablishedPremises_cons_discharged (headAgrees.symm.trans discharged), tailAgrees]
      · rw [unestablishedPremises_cons_open discharged,
          unestablishedPremises_cons_open (fun other => discharged (headAgrees.trans other)),
          tailAgrees]

/-- **A claim's standing reads only its own support.** Two ledgers that agree on the premises
a claim rests on give it the same standing, whatever they say about every other premise. This
is the exact blast radius: refuting a premise voids the claims resting on it and leaves the
rest untouched. -/
theorem supportStanding_congr {left right : Assurance} {support : List Premise}
    (agree : ∀ premise ∈ support, left.standing premise = right.standing premise) :
    supportStanding left support = supportStanding right support := by
  have failed := refutedPremises_congr agree
  have unestablished := unestablishedPremises_congr agree
  cases result : supportStanding left support with
  | void =>
      have nonempty := supportStanding_void_iff.mp result
      rw [failed] at nonempty
      exact (supportStanding_void_iff.mpr nonempty).symm
  | conditional =>
      obtain ⟨bare, nonempty⟩ := supportStanding_conditional_iff.mp result
      rw [failed] at bare
      rw [unestablished] at nonempty
      exact (supportStanding_conditional_iff.mpr ⟨bare, nonempty⟩).symm
  | proved =>
      obtain ⟨bare, established⟩ := supportStanding_proved_iff.mp result
      rw [failed] at bare
      rw [unestablished] at established
      exact (supportStanding_proved_iff.mpr ⟨bare, established⟩).symm

theorem standing_reads_only_its_support {self : Claim} {left right : Assurance}
    (agree : ∀ premise ∈ self.support, left.standing premise = right.standing premise) :
    self.standing left = self.standing right :=
  supportStanding_congr agree

/-- **Safety survives a progress refutation.** A claim resting only on safety premises keeps
its standing across two ledgers that differ solely on progress premises. The doctrine's rule
that no designated safety theorem assumes delivery, fairness, or progress becomes a
consequence of the support rather than a sentence in a boundary field. -/
theorem safety_survives_progress_refutation {self : Claim} {left right : Assurance}
    (safetyOnly : ∀ premise ∈ self.support, premise.kind = .safety)
    (agreeOnSafety : ∀ premise : Premise, premise.kind = .safety →
      left.standing premise = right.standing premise) :
    self.standing left = self.standing right :=
  standing_reads_only_its_support fun premise member =>
    agreeOnSafety premise (safetyOnly premise member)

/-- **A liveness claim is never unconditional.** A well-formed one rests on a progress
premise, so `unconditional_claim_is_proved` can never reach it. -/
theorem liveness_is_never_unconditional {self : Claim} (wellFormed : self.WellFormed)
    (live : self.modality = .liveness) : self.support ≠ [] := by
  obtain ⟨premise, member, _⟩ := wellFormed live
  intro bare
  rw [bare] at member
  exact absurd member List.not_mem_nil

/-- A `withinModel` fault voids nothing. Its observation enters no refutation —
`within_model_verdict_is_unbound` refuses the report and
`within_model_fault_has_no_durable_refutation` refuses the record — so the ledger before and
after agree on every premise, and every claim keeps its standing. -/
theorem within_model_fault_voids_nothing {self : Claim} {left right : Assurance}
    (sameEvidence : left.domainEvidence = right.domainEvidence)
    (sameRefutations : left.refutations = right.refutations) :
    self.standing left = self.standing right :=
  standing_reads_only_its_support fun _ _ =>
    watching_is_not_standing sameEvidence sameRefutations

end RuntimeAssurance
