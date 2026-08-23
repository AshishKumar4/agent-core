import AgentCore.Capability
import AgentCore.Scopes

/-!
# Deny precedence and Grant resolution (SPEC §3.3, §3.4)

SPEC §3.3 states effective authority as a two-sided condition over the whole Grant set:
"Effective authority exists exactly when at least one live matching allow-Grant reaches the
target Scope and no live matching deny-Grant exists on the ordered Tenant-to-target path."
Getting either side wrong is a security defect — a missed deny grants authority that was
revoked, a spurious deny denies legitimate work.

`AgentCore.AuthorityLedger.deny_overrides` states the precedence over the abstract ledger,
where `Authorized` carries `¬ Denied` as a conjunct; that theorem is about the relation, not
about any decision procedure. This module supplies the decision. `EffectiveAuthority` is
§3.3 stated exactly, quantified over the intent domain through `Capability.Matches`;
`evaluateExec` is the executable decision, following `AuthorityRuntime.evaluate`'s own gate
order; and `authority_decision_is_sound` proves the decision never allows where §3.3
refuses.

## What carries the weight

Three relations meet here, each defined independently of the decision that uses it.

- `ScopeReaches` is SPEC §3.2's fixed `Tenant ⊇ Project ⊇ Workspace` chain, given as four
  constructors. The resolver decides reach by membership in the target's Scope path, and its
  lineage walk decides it a second way, by comparing positions in that path.
  `scope_reaches_iff_mem_path` and `path_index_le_iff_reaches` prove both are the chain
  relation, so neither check is a separate notion of containment that could drift from it.
- `Capability.Matches` is admission over the infinite intent domain (`AC-CAPABILITY-001`).
  A Grant matches a request through it, so "matching" in §3.3's sentence means what §3.3
  means, not what the executable comparison happens to compute.
- `Capability.Covers` is §3.4 rule 2. `lineage_ok_ancestor_covers` proves the resolver's
  pairwise lineage walk yields containment against *every* ancestor, at every depth, which
  is the property rule 2 states and the pairwise check does not obviously give.

## What this does and does not carry

The decision modeled here begins where the resolver has already established the request: the
effective subject set, the exact Scope path, the intent, and the Binding's backing Grant id.
Binding canonicality, path-epoch staleness, Principal liveness, and the Binding-to-Facet
match are gates the implementation runs before this point; they are fail-closed refusals, so
omitting them can only make the modeled decision more permissive than the implementation,
never less — soundness therefore carries, and completeness is stated relative to them
holding.

Subjects and Scopes are compared as values here, while the implementation compares the
canonical-JSON keys `subjectKey` and `scopeKey`. `AgentCore.authorityKey_injective` proves
that comparison is value comparison with no side condition on the identifier text, so value
equality is the right model of what the resolver runs.

The two sides of §3.3 do not read the same subject. A foreign subject carries the
`verifiedVia` stamp naming how the guest proved who they are, and §3.3 lets that stamp
change over a Principal's lifetime. An allow is matched on the whole stamped subject, which
is what lets a Tenant scope an allow to the verification scheme it trusts; a deny is matched
on `Subject.identity`, which drops the stamp, because a deny names who is refused and a
re-verified guest is the same who. `matches_deny_of_matches_request` proves the deny side is
the coarser of the two, so the asymmetry can only refuse more.

Guest verification currency (`guestGrantIsCurrent`) reads Membership and GuestTrust records
and is not modeled; a guest request is modeled only through the elevation prohibition. The
lineage walk is bounded by the Grant count and refuses on exhaustion, matching the
implementation's refusal of a repeated Grant; that the bound never binds for an acyclic
lineage is not proved here.
-/

namespace AgentCore

/-! ## Scope-chain reachability (SPEC §3.2)

A Grant at an ancestor Scope reaches every descendant. The chain is fixed at three levels
with an optional Project, so the relation has exactly four ways to hold. -/

/-- SPEC §3.2's containment chain, stated as itself rather than through any path list. -/
inductive ScopeReaches : Scope → Scope → Prop
  | same (scope : Scope) : ScopeReaches scope scope
  | tenantOfProject (tenant : TenantId) (project : ProjectId) :
      ScopeReaches (.tenant tenant) (.project tenant project)
  | tenantOfWorkspace (tenant : TenantId) (project : Option ProjectId) (workspace : WorkspaceId) :
      ScopeReaches (.tenant tenant) (.workspace tenant project workspace)
  | projectOfWorkspace (tenant : TenantId) (project : ProjectId) (workspace : WorkspaceId) :
      ScopeReaches (.project tenant project) (.workspace tenant (some project) workspace)

/-- **The resolver's reach test is the SPEC chain.** `AuthorityRuntime` decides that a Grant
reaches the target by membership in the target's Scope path; this is that membership and
SPEC §3.2's chain relation agreeing, in both directions. -/
theorem scope_reaches_iff_mem_path {ancestor target : Scope} :
    ScopeReaches ancestor target ↔ ancestor ∈ target.path := by
  constructor
  · intro reaches
    cases reaches with
    | same => exact Scope.self_mem_path _
    | tenantOfProject => simp [Scope.path]
    | tenantOfWorkspace _ project => cases project <;> simp [Scope.path]
    | projectOfWorkspace => simp [Scope.path]
  · intro member
    cases target with
    | tenant tenant =>
        simp only [Scope.path, List.mem_singleton] at member
        exact member ▸ .same _
    | project tenant project =>
        simp only [Scope.path, List.mem_cons, List.not_mem_nil, or_false] at member
        rcases member with rfl | rfl
        · exact .same _
        · exact .tenantOfProject _ _
    | workspace tenant project workspace =>
        cases project with
        | none =>
            simp only [Scope.path, List.mem_cons, List.not_mem_nil, or_false] at member
            rcases member with rfl | rfl
            · exact .same _
            · exact .tenantOfWorkspace _ _ _
        | some project =>
            simp only [Scope.path, List.mem_cons, List.not_mem_nil, or_false] at member
            rcases member with rfl | rfl | rfl
            · exact .same _
            · exact .projectOfWorkspace _ _ _
            · exact .tenantOfWorkspace _ _ _

/-- Reach composes: a Grant at the Tenant reaches a Workspace through its Project, which is
what makes an ancestor deny apply to every descendant below it. -/
theorem scope_reaches_trans {outer middle inner : Scope}
    (first : ScopeReaches outer middle) (second : ScopeReaches middle inner) :
    ScopeReaches outer inner := by
  cases first with
  | same => exact second
  | tenantOfProject =>
      cases second with
      | same => exact .tenantOfProject _ _
      | projectOfWorkspace => exact .tenantOfWorkspace _ _ _
  | tenantOfWorkspace => cases second with | same => exact .tenantOfWorkspace _ _ _
  | projectOfWorkspace => cases second with | same => exact .projectOfWorkspace _ _ _

/-- The chain has no cycles: two Scopes that reach each other are the same Scope. -/
theorem scope_reaches_antisymm {left right : Scope} (forward : ScopeReaches left right)
    (backward : ScopeReaches right left) : left = right := by
  cases forward with
  | same => rfl
  | tenantOfProject => cases backward
  | tenantOfWorkspace => cases backward
  | projectOfWorkspace => cases backward

/-! ## Path positions

`validateLineage` decides containment a second way: it indexes both Scopes into the exact
Tenant-to-target path and refuses a parent positioned below its child. `Scope.orderedPath`
is that Tenant-to-target list. -/

def indexIn : List Scope → Scope → Option Nat
  | [], _ => none
  | head :: tail, wanted =>
      if head = wanted then some 0 else (indexIn tail wanted).map (· + 1)

/-- The position a Scope occupies on the exact Tenant-to-target path, absent when it is not
on that path at all. -/
def pathIndex (target scope : Scope) : Option Nat := indexIn target.orderedPath scope

theorem indexIn_cons {head : Scope} {tail : List Scope} {scope : Scope} {index : Nat}
    (found : indexIn (head :: tail) scope = some index) :
    (head = scope ∧ index = 0) ∨
      (head ≠ scope ∧ ∃ inner, indexIn tail scope = some inner ∧ index = inner + 1) := by
  simp only [indexIn] at found
  split at found
  · next same => exact Or.inl ⟨same, by simpa using found.symm⟩
  · next different =>
      rw [Option.map_eq_some_iff] at found
      obtain ⟨inner, innerFound, position⟩ := found
      exact Or.inr ⟨different, inner, innerFound, position.symm⟩

theorem indexIn_mem {scopes : List Scope} {scope : Scope} {index : Nat}
    (found : indexIn scopes scope = some index) : scope ∈ scopes := by
  induction scopes generalizing index with
  | nil => simp [indexIn] at found
  | cons head tail ih =>
      rcases indexIn_cons found with ⟨same, _⟩ | ⟨_, inner, innerFound, _⟩
      · exact same ▸ List.mem_cons_self
      · exact List.Mem.tail head (ih innerFound)

/-- One position names one Scope: the scan returns the first match, so equal positions come
from equal Scopes without any duplicate-freedom premise. -/
theorem indexIn_injective {scopes : List Scope} {left right : Scope} {index : Nat}
    (leftFound : indexIn scopes left = some index)
    (rightFound : indexIn scopes right = some index) : left = right := by
  induction scopes generalizing index with
  | nil => simp [indexIn] at leftFound
  | cons head tail ih =>
      rcases indexIn_cons leftFound with ⟨leftSame, leftZero⟩ |
        ⟨_, leftInner, leftInnerFound, leftSucc⟩
      · rcases indexIn_cons rightFound with ⟨rightSame, _⟩ | ⟨_, _, _, rightSucc⟩
        · exact leftSame ▸ rightSame ▸ rfl
        · omega
      · rcases indexIn_cons rightFound with ⟨_, rightZero⟩ |
          ⟨_, rightInner, rightInnerFound, rightSucc⟩
        · omega
        · have same : leftInner = rightInner := by omega
          exact ih leftInnerFound (same ▸ rightInnerFound)

/-- A strictly earlier position on a list ordered by `order` is related to a later one. -/
theorem indexIn_lt_ordered {order : Scope → Scope → Prop} {scopes : List Scope}
    (ordered : scopes.Pairwise order) :
    ∀ {left right : Scope} {leftIndex rightIndex : Nat},
      indexIn scopes left = some leftIndex → indexIn scopes right = some rightIndex →
      leftIndex < rightIndex → order left right := by
  induction ordered with
  | nil => intro _ _ _ _ leftFound; simp [indexIn] at leftFound
  | @cons head tail heads _ ih =>
      intro left right leftIndex rightIndex leftFound rightFound below
      rcases indexIn_cons leftFound with ⟨leftSame, leftZero⟩ | ⟨_, _, leftInnerFound, leftSucc⟩
      · rcases indexIn_cons rightFound with ⟨_, rightZero⟩ | ⟨_, _, rightInnerFound, _⟩
        · omega
        · exact leftSame ▸ heads right (indexIn_mem rightInnerFound)
      · rcases indexIn_cons rightFound with ⟨_, rightZero⟩ | ⟨_, _, rightInnerFound, rightSucc⟩
        · omega
        · exact ih leftInnerFound rightInnerFound (by omega)

theorem orderedPath_tenant (tenant : TenantId) :
    (Scope.tenant tenant).orderedPath = [.tenant tenant] := rfl

theorem orderedPath_project (tenant : TenantId) (project : ProjectId) :
    (Scope.project tenant project).orderedPath = [.tenant tenant, .project tenant project] := rfl

theorem orderedPath_workspace_direct (tenant : TenantId) (workspace : WorkspaceId) :
    (Scope.workspace tenant none workspace).orderedPath =
      [.tenant tenant, .workspace tenant none workspace] := rfl

theorem orderedPath_workspace_nested (tenant : TenantId) (project : ProjectId)
    (workspace : WorkspaceId) :
    (Scope.workspace tenant (some project) workspace).orderedPath =
      [.tenant tenant, .project tenant project, .workspace tenant (some project) workspace] := rfl

/-- The exact Tenant-to-target path is ordered by the chain relation itself. -/
theorem orderedPath_pairwise (target : Scope) :
    target.orderedPath.Pairwise ScopeReaches := by
  cases target with
  | tenant tenant => rw [orderedPath_tenant]; simp
  | project tenant project =>
      rw [orderedPath_project]
      simp only [List.pairwise_cons, List.mem_cons, List.not_mem_nil]
      refine ⟨?_, by simp⟩
      rintro other (rfl | ⟨_, _⟩)
      exact .tenantOfProject _ _
  | workspace tenant project workspace =>
      cases project with
      | none =>
          rw [orderedPath_workspace_direct]
          simp only [List.pairwise_cons, List.mem_cons, List.not_mem_nil]
          refine ⟨?_, by simp⟩
          rintro other (rfl | ⟨_, _⟩)
          exact .tenantOfWorkspace _ _ _
      | some project =>
          rw [orderedPath_workspace_nested]
          simp only [List.pairwise_cons, List.mem_cons, List.not_mem_nil,
            or_false]
          refine ⟨?_, ?_, by simp⟩
          · rintro other (rfl | rfl)
            · exact .tenantOfProject _ _
            · exact .tenantOfWorkspace _ _ _
          · rintro other rfl
            exact .projectOfWorkspace _ _ _

theorem path_index_mem {target scope : Scope} {index : Nat}
    (found : pathIndex target scope = some index) : scope ∈ target.path := by
  have member := indexIn_mem found
  simpa [Scope.orderedPath] using member

theorem indexIn_of_mem {scopes : List Scope} {scope : Scope} (member : scope ∈ scopes) :
    ∃ index, indexIn scopes scope = some index := by
  induction scopes with
  | nil => exact absurd member List.not_mem_nil
  | cons head tail ih =>
      by_cases same : head = scope
      · exact ⟨0, by simp [indexIn, same]⟩
      · obtain ⟨inner, innerFound⟩ := ih ((List.mem_cons.mp member).resolve_left
          fun equal => same equal.symm)
        exact ⟨inner + 1, by simp [indexIn, same, innerFound]⟩

/-- **The index test refuses no containment the path test admits.** `validateLineage` demands
that both Scopes carry a position on the exact path, which looks stricter than reach; it is
not. Once the child is on the path, every Scope reaching it is on the path too, so the walk
never refuses a delegation SPEC §3.2 containment allows. -/
theorem path_index_defined_of_reaches {target parent child : Scope} {childIndex : Nat}
    (childFound : pathIndex target child = some childIndex)
    (reaches : ScopeReaches parent child) : ∃ index, pathIndex target parent = some index := by
  have member : parent ∈ target.path :=
    scope_reaches_iff_mem_path.mp
      (scope_reaches_trans reaches (scope_reaches_iff_mem_path.mpr (path_index_mem childFound)))
  exact indexIn_of_mem (by simpa [Scope.orderedPath] using member)

/-- **The lineage walk's position test is the same chain relation.** For two Scopes on the
exact path, the parent-below-child refusal `validateLineage` runs decides exactly
`ScopeReaches`, so the resolver's two containment checks cannot disagree. -/
theorem path_index_le_iff_reaches {target parent child : Scope} {parentIndex childIndex : Nat}
    (parentFound : pathIndex target parent = some parentIndex)
    (childFound : pathIndex target child = some childIndex) :
    parentIndex ≤ childIndex ↔ ScopeReaches parent child := by
  constructor
  · intro bound
    rcases Nat.lt_or_ge parentIndex childIndex with below | above
    · exact indexIn_lt_ordered (orderedPath_pairwise target) parentFound childFound below
    · have same : parentIndex = childIndex := Nat.le_antisymm bound above
      exact indexIn_injective parentFound (same ▸ childFound) ▸ .same _
  · intro reaches
    rcases Nat.lt_or_ge childIndex parentIndex with below | above
    · exact absurd (scope_reaches_antisymm reaches
        (indexIn_lt_ordered (orderedPath_pairwise target) childFound parentFound below))
        (fun same => by
          subst same
          exact absurd (Option.some.inj (parentFound.symm.trans childFound)) (by omega))
    · omega

/-! ## Grants and requests -/

/-- A Grant as the resolver reads it: the identity, the subject and Scope it was issued at,
its effect, the capability it carries, its attenuation parent, and whether it is live. -/
structure AuthorityGrant where
  id : GrantId
  subject : Subject
  scope : Scope
  effect : GrantEffect
  capability : Capability
  attenuationOf : Option GrantId
  live : Bool
  deriving DecidableEq, Repr

/-- What the resolver has already established when precedence is evaluated: the subjects the
Principal acts under, the exact target Scope, and the Invocation intent. -/
structure AuthorityRequest where
  subjects : List Subject
  target : Scope
  intent : CapabilityIntent
  deriving DecidableEq, Repr

/-- Who a subject is, with a guest's verification stamp dropped. -/
inductive SubjectIdentity where
  | principal (ref : PrincipalRef)
  | team (id : TeamId)
  | foreign (homeTenant : TenantId) (id : PrincipalId)
  deriving DecidableEq, Repr

/-- A subject read as the identity it names rather than as how that identity was proved.
`verifiedVia` qualifies a foreign Principal; it does not name a different one. -/
def Subject.identity : Subject → SubjectIdentity
  | .principal ref => .principal ref
  | .team id => .team id
  | .foreign home id _ => .foreign home id

/-- **One guest is one identity under every scheme.** The stamp separates subjects and does
not separate the Principal they name, which is what makes a deny recorded under one scheme
a deny of the same guest under another. -/
theorem subject_identity_drops_verification_scheme (home : TenantId) (principal : PrincipalId)
    (left right : GuestScheme) :
    (Subject.foreign home principal left).identity =
      (Subject.foreign home principal right).identity := rfl

/-- SPEC §3.3's "matching" allow-Grant: an acting subject, reach to the target, and an
admitted intent. Admission is `Capability.Matches`, so this quantifies over the intent domain
rather than over what any comparison computes. The subject is matched whole, stamp included,
which is what makes an allow issued under one verification scheme authority under that
scheme only. -/
def AuthorityGrant.MatchesRequest (grant : AuthorityGrant) (request : AuthorityRequest) : Prop :=
  grant.subject ∈ request.subjects ∧ ScopeReaches grant.scope request.target ∧
  grant.capability.Matches request.intent

/-- The executable form: subject membership, Scope-path membership, and the executable
capability decision. -/
def AuthorityGrant.matchesRequestBool (grant : AuthorityGrant) (request : AuthorityRequest) :
    Bool :=
  decide (grant.subject ∈ request.subjects) && decide (grant.scope ∈ request.target.path) &&
    grant.capability.matchesBool request.intent

/-- SPEC §3.3's "matching" deny-Grant. Same reach and same intent admission, and the subject
matched on identity: a deny names who is refused, so the guest's verification stamp is not
part of what it matches. -/
def AuthorityGrant.MatchesDeny (grant : AuthorityGrant) (request : AuthorityRequest) : Prop :=
  grant.subject.identity ∈ request.subjects.map Subject.identity ∧
  ScopeReaches grant.scope request.target ∧ grant.capability.Matches request.intent

def AuthorityGrant.matchesDenyBool (grant : AuthorityGrant) (request : AuthorityRequest) :
    Bool :=
  decide (grant.subject.identity ∈ request.subjects.map Subject.identity) &&
    decide (grant.scope ∈ request.target.path) && grant.capability.matchesBool request.intent

theorem authority_grant_matches_iff {grant : AuthorityGrant} {request : AuthorityRequest} :
    grant.matchesRequestBool request = true ↔ grant.MatchesRequest request := by
  simp only [AuthorityGrant.matchesRequestBool, AuthorityGrant.MatchesRequest, Bool.and_eq_true,
    decide_eq_true_eq, capability_matches_iff, scope_reaches_iff_mem_path]
  constructor
  · rintro ⟨⟨subject, scope⟩, intent⟩
    exact ⟨subject, scope, intent⟩
  · rintro ⟨subject, scope, intent⟩
    exact ⟨⟨subject, scope⟩, intent⟩

theorem authority_grant_matches_deny_iff {grant : AuthorityGrant} {request : AuthorityRequest} :
    grant.matchesDenyBool request = true ↔ grant.MatchesDeny request := by
  simp only [AuthorityGrant.matchesDenyBool, AuthorityGrant.MatchesDeny, Bool.and_eq_true,
    decide_eq_true_eq, capability_matches_iff, scope_reaches_iff_mem_path]
  constructor
  · rintro ⟨⟨subject, scope⟩, intent⟩
    exact ⟨subject, scope, intent⟩
  · rintro ⟨subject, scope, intent⟩
    exact ⟨⟨subject, scope⟩, intent⟩

/-- **The deny side matches everything the allow side does.** Dropping the stamp is a
widening, so the asymmetry can only refuse more requests, never admit one the exact
comparison would have refused. -/
theorem matches_deny_of_matches_request {grant : AuthorityGrant} {request : AuthorityRequest}
    (matched : grant.MatchesRequest request) : grant.MatchesDeny request :=
  ⟨List.mem_map_of_mem matched.1, matched.2.1, matched.2.2⟩

instance (grant : AuthorityGrant) (request : AuthorityRequest) :
    Decidable (grant.MatchesRequest request) :=
  decidable_of_iff _ authority_grant_matches_iff

instance (grant : AuthorityGrant) (request : AuthorityRequest) :
    Decidable (grant.MatchesDeny request) :=
  decidable_of_iff _ authority_grant_matches_deny_iff

/-! ## The §3.3 precedence condition -/

/-- A live allow-Grant matching the request, subject and stamp both. -/
def LiveAllowing (grants : List AuthorityGrant) (request : AuthorityRequest) : Prop :=
  ∃ grant ∈ grants, grant.live = true ∧ grant.effect = .allow ∧ grant.MatchesRequest request

/-- A live deny-Grant matching the request's subject identity. -/
def LiveDenying (grants : List AuthorityGrant) (request : AuthorityRequest) : Prop :=
  ∃ grant ∈ grants, grant.live = true ∧ grant.effect = .deny ∧ grant.MatchesDeny request

/-- **SPEC §3.3 precedence, stated exactly.** Effective authority exists exactly when at
least one live matching allow-Grant reaches the target Scope and no live matching deny-Grant
does. -/
def EffectiveAuthority (grants : List AuthorityGrant) (request : AuthorityRequest) : Prop :=
  LiveAllowing grants request ∧ ¬ LiveDenying grants request

/-- **A deny anywhere above the target defeats every allow below it.** This is §3.3's "a
descendant allow MUST NOT re-widen an ancestor deny": the deny is issued at a Scope that
reaches some intermediate Scope on the path, and reach composes, so it reaches the target
and no allow at any depth can restore authority. -/
theorem ancestor_deny_defeats_descendant_allow {grants : List AuthorityGrant}
    {request : AuthorityRequest} {denyGrant : AuthorityGrant} {middle : Scope}
    (member : denyGrant ∈ grants) (live : denyGrant.live = true)
    (effect : denyGrant.effect = .deny)
    (subject : denyGrant.subject.identity ∈ request.subjects.map Subject.identity)
    (above : ScopeReaches denyGrant.scope middle) (below : ScopeReaches middle request.target)
    (admits : denyGrant.capability.Matches request.intent) :
    ¬ EffectiveAuthority grants request := fun effective =>
  effective.2 ⟨denyGrant, member, live, effect, subject, scope_reaches_trans above below, admits⟩

/-- **A deny is not escaped by re-verifying.** A live deny recorded for a foreign Principal
under one verification scheme refuses a request the same Principal makes under another. This
is the reachable case: §3.3 lets the stamp change over a Principal's lifetime, and a Grant's
subject is immutable, so a deny recorded before the change cannot be restamped to follow it.
Deny matching therefore has to read the identity a stamp qualifies rather than the stamp. -/
theorem deny_survives_verification_scheme_change {grants : List AuthorityGrant}
    {request : AuthorityRequest} {denyGrant : AuthorityGrant} {home : TenantId}
    {principal : PrincipalId} {recorded requested : GuestScheme} (member : denyGrant ∈ grants)
    (live : denyGrant.live = true) (effect : denyGrant.effect = .deny)
    (stamped : denyGrant.subject = .foreign home principal recorded)
    (acting : Subject.foreign home principal requested ∈ request.subjects)
    (reaches : ScopeReaches denyGrant.scope request.target)
    (admits : denyGrant.capability.Matches request.intent) :
    ¬ EffectiveAuthority grants request := by
  intro effective
  refine effective.2 ⟨denyGrant, member, live, effect, ?_, reaches, admits⟩
  simpa [stamped, Subject.identity] using List.mem_map_of_mem acting

/-- **An allow is authority only under the scheme it was verified with.** The same foreign
Principal stamped by another scheme is another subject to the allow side, which is what lets
a Tenant scope an allow to the verification scheme it trusts. -/
theorem allow_requires_exact_verification_scheme {grant : AuthorityGrant}
    {request : AuthorityRequest} {home : TenantId} {principal : PrincipalId}
    {recorded requested : GuestScheme} (different : recorded ≠ requested)
    (stamped : grant.subject = .foreign home principal recorded)
    (acting : request.subjects = [.foreign home principal requested]) :
    ¬ grant.MatchesRequest request := by
  intro matched
  have member := matched.1
  rw [stamped, acting] at member
  simp only [List.mem_singleton, Subject.foreign.injEq, true_and] at member
  exact different member

/-! ## The attenuation lineage walk

`validateLineage` walks parent pointers from a Grant to its root, refusing a revoked link, a
repeated Grant, a non-allow parent, a parent positioned below its child on the path, and a
parent whose capability does not cover its child's. -/

inductive LineageVerdict where
  | ok
  | revokedGrant
  | invalidDelegation
  deriving DecidableEq, Repr

def lookupGrant : List AuthorityGrant → GrantId → Option AuthorityGrant
  | [], _ => none
  | grant :: rest, wanted => if grant.id = wanted then some grant else lookupGrant rest wanted

theorem lookupGrant_mem {grants : List AuthorityGrant} {wanted : GrantId}
    {grant : AuthorityGrant} (found : lookupGrant grants wanted = some grant) :
    grant ∈ grants := by
  induction grants with
  | nil => simp [lookupGrant] at found
  | cons head rest ih =>
      simp only [lookupGrant] at found
      split at found
      · simp only [Option.some.injEq] at found
        exact found ▸ List.mem_cons_self
      · exact List.Mem.tail head (ih found)

/-- One step of the walk, carrying the Grants already visited and a step budget. Exhaustion
is refused as an invalid delegation, matching the implementation's refusal of a repeated
Grant. -/
def lineageStep (grants : List AuthorityGrant) (target : Scope) :
    Nat → List GrantId → AuthorityGrant → LineageVerdict
  | 0, _, _ => .invalidDelegation
  | budget + 1, visited, child =>
      if child.live = true then
        if child.id ∈ visited then .invalidDelegation
        else
          match child.attenuationOf with
          | none => .ok
          | some parentId =>
            match lookupGrant grants parentId with
            | none => .revokedGrant
            | some parent =>
              if parent.live = true then
                if parent.effect = .allow then
                  match pathIndex target parent.scope, pathIndex target child.scope with
                  | some parentIndex, some childIndex =>
                      if parentIndex ≤ childIndex then
                        if parent.capability.coversBool child.capability = true then
                          lineageStep grants target budget (child.id :: visited) parent
                        else .invalidDelegation
                      else .invalidDelegation
                  | _, _ => .invalidDelegation
                else .invalidDelegation
              else .revokedGrant
      else .revokedGrant

/-- The whole walk, budgeted by the Grant count: a chain that revisits a Grant is refused
before the budget can bind. -/
def lineageExec (grants : List AuthorityGrant) (target : Scope) (grant : AuthorityGrant) :
    LineageVerdict :=
  lineageStep grants target (grants.length + 1) [] grant

/-- The attenuation ancestry the walk follows: reflexive, and one link per parent pointer
resolved against the same Grant set. -/
inductive LineageAncestor (grants : List AuthorityGrant) :
    AuthorityGrant → AuthorityGrant → Prop
  | self (grant : AuthorityGrant) : LineageAncestor grants grant grant
  | parent {child parent ancestor : AuthorityGrant} {parentId : GrantId} :
      child.attenuationOf = some parentId → lookupGrant grants parentId = some parent →
      LineageAncestor grants parent ancestor → LineageAncestor grants child ancestor

theorem covers_trans {outer middle inner : Capability}
    (first : outer.Covers middle) (second : middle.Covers inner) : outer.Covers inner :=
  fun intent matched => first intent (second intent matched)

/-- **Every ancestor covers its descendant, at every depth of the lineage.** SPEC §3.4
rule 2 demands the property against the whole lineage, while the resolver checks adjacent
pairs. This is the lift, stated over the walk the resolver actually runs: whenever it admits
a Grant, no ancestor of that Grant refuses an intent the Grant admits. -/
theorem lineage_ok_ancestor_covers {grants : List AuthorityGrant} {target : Scope} :
    ∀ {budget : Nat} {visited : List GrantId} {child ancestor : AuthorityGrant},
      lineageStep grants target budget visited child = .ok →
      LineageAncestor grants child ancestor →
      ancestor.capability.Covers child.capability := by
  intro budget
  induction budget with
  | zero => intro _ _ _ walked _; simp [lineageStep] at walked
  | succ budget ih =>
      intro visited child ancestor walked ancestry
      cases ancestry with
      | self => exact fun _ matched => matched
      | @parent _ parentGrant _ parentId edge lookup rest =>
          simp only [lineageStep, edge, lookup] at walked
          split at walked
          · split at walked
            · exact absurd walked (by simp)
            · split at walked
              · split at walked
                · split at walked
                  · split at walked
                    · split at walked
                      · exact covers_trans (ih walked rest) (capability_covering_is_sound (by
                          rename_i covering; exact covering))
                      · exact absurd walked (by simp)
                    · exact absurd walked (by simp)
                  · exact absurd walked (by simp)
                · exact absurd walked (by simp)
              · exact absurd walked (by simp)
          · exact absurd walked (by simp)

/-- **A revoked Grant anywhere in the lineage refuses the whole chain.** Revocation disables
descendants (§3.4), and the walk is where that happens. -/
theorem lineage_ok_ancestors_live {grants : List AuthorityGrant} {target : Scope} :
    ∀ {budget : Nat} {visited : List GrantId} {child ancestor : AuthorityGrant},
      lineageStep grants target budget visited child = .ok →
      LineageAncestor grants child ancestor → ancestor.live = true := by
  intro budget
  induction budget with
  | zero => intro _ _ _ walked _; simp [lineageStep] at walked
  | succ budget ih =>
      intro visited child ancestor walked ancestry
      cases ancestry with
      | self =>
          simp only [lineageStep] at walked
          split at walked
          · assumption
          · exact absurd walked (by simp)
      | @parent _ parentGrant _ parentId edge lookup rest =>
          simp only [lineageStep, edge, lookup] at walked
          split at walked
          · split at walked
            · exact absurd walked (by simp)
            · split at walked
              · split at walked
                · split at walked
                  · split at walked
                    · split at walked
                      · exact ih walked rest
                      · exact absurd walked (by simp)
                    · exact absurd walked (by simp)
                  · exact absurd walked (by simp)
                · exact absurd walked (by simp)
              · exact absurd walked (by simp)
          · exact absurd walked (by simp)

/-! ## The resolution decision

`evaluateExec` follows `AuthorityRuntime.evaluate`'s gate order over the Grant plane: the
deny sweep first, then the guest elevation prohibition, then the Binding's backing Grant and
its lineage. -/

inductive AuthorityDecision where
  | allowed
  | matchingDeny
  | guestElevation
  | missingGrant
  | revokedGrant
  | invalidDelegation
  | noMatchingAllow
  deriving DecidableEq, Repr

/-- The two impacts a guest may never reach (§3.3). -/
def InvocationImpact.elevating : InvocationImpact → Bool
  | .delegate | .administer => true
  | _ => false

/-- Everything the decision reads: the Grant plane, the resolved request, whether the
Principal is a guest of another Tenant, and the Grant the Binding names. -/
structure AuthorityInput where
  grants : List AuthorityGrant
  request : AuthorityRequest
  guest : Bool
  backing : GrantId
  deriving DecidableEq, Repr

/-- The live matching deny-Grants, which is the list the evidence record carries. -/
def AuthorityInput.denials (input : AuthorityInput) : List AuthorityGrant :=
  input.grants.filter fun grant =>
    grant.matchesDenyBool input.request && grant.live && grant.effect == .deny

def evaluateExec (input : AuthorityInput) : AuthorityDecision :=
  if input.denials = [] then
    if input.guest = true ∧ input.request.intent.impact.elevating = true then .guestElevation
    else
      match lookupGrant input.grants input.backing with
      | none => .missingGrant
      | some backing =>
        if backing.effect = .allow then
          if backing.live = true then
            if backing.matchesRequestBool input.request = true then
              match lineageExec input.grants input.request.target backing with
              | .ok => .allowed
              | .revokedGrant => .revokedGrant
              | .invalidDelegation => .invalidDelegation
            else .noMatchingAllow
          else .revokedGrant
        else .missingGrant
  else .matchingDeny

theorem denials_empty_iff {input : AuthorityInput} :
    input.denials = [] ↔ ¬ LiveDenying input.grants input.request := by
  constructor
  · rintro empty ⟨grant, member, live, effect, matched⟩
    have listed : grant ∈ input.denials := by
      simp only [AuthorityInput.denials, List.mem_filter, Bool.and_eq_true, beq_iff_eq]
      exact ⟨member, ⟨authority_grant_matches_deny_iff.mpr matched, live⟩, effect⟩
    rw [empty] at listed
    exact absurd listed List.not_mem_nil
  · intro absent
    cases hypothesis : input.denials with
    | nil => rfl
    | cons head _ =>
        have member : head ∈ input.denials := by rw [hypothesis]; exact List.mem_cons_self
        simp only [AuthorityInput.denials, List.mem_filter, Bool.and_eq_true, beq_iff_eq]
          at member
        exact absurd ⟨head, member.1, member.2.1.2, member.2.2,
          authority_grant_matches_deny_iff.mp member.2.1.1⟩ absent

/-- The Binding integrity the decision requires beyond §3.3: the Grant a Binding names must
itself be a live matching allow whose attenuation lineage the walk admits. -/
structure BackingSound (input : AuthorityInput) (backing : AuthorityGrant) : Prop where
  lookup : lookupGrant input.grants input.backing = some backing
  live : backing.live = true
  allow : backing.effect = .allow
  admits : backing.MatchesRequest input.request
  lineage : lineageExec input.grants input.request.target backing = .ok

/-- Everything an `allowed` answer establishes about the Grant plane: no live matching deny,
and a Binding whose backing Grant passed every gate. -/
theorem allowed_names_sound_backing {input : AuthorityInput}
    (allowed : evaluateExec input = .allowed) :
    input.denials = [] ∧ ∃ backing, BackingSound input backing := by
  unfold evaluateExec at allowed
  split at allowed
  · next noDenials =>
      refine ⟨noDenials, ?_⟩
      split at allowed
      · exact absurd allowed (by simp)
      · split at allowed
        · exact absurd allowed (by simp)
        · next backing lookup =>
            split at allowed
            · next allow =>
                split at allowed
                · next live =>
                    split at allowed
                    · next matched =>
                        split at allowed
                        · next walked =>
                            exact ⟨backing, lookup, live, allow,
                              authority_grant_matches_iff.mp matched, walked⟩
                        · exact absurd allowed (by simp)
                        · exact absurd allowed (by simp)
                    · exact absurd allowed (by simp)
                · exact absurd allowed (by simp)
            · exact absurd allowed (by simp)
  · exact absurd allowed (by simp)

/-- **The resolution decision never allows where SPEC §3.3 refuses.** Whenever the decision
answers `allowed`, a live matching allow-Grant reaches the target and no live matching
deny-Grant does — the §3.3 condition itself, over the whole intent domain, not the
conjunction the check evaluates. -/
theorem authority_decision_is_sound {input : AuthorityInput}
    (allowed : evaluateExec input = .allowed) :
    EffectiveAuthority input.grants input.request := by
  obtain ⟨noDenials, backing, sound⟩ := allowed_names_sound_backing allowed
  exact ⟨⟨backing, lookupGrant_mem sound.lookup, sound.live, sound.allow, sound.admits⟩,
    denials_empty_iff.mp noDenials⟩

/-- **Under a sound Binding, the decision is exactly deny precedence.** Nothing else in the
Grant plane can refuse and nothing else can admit: the answer is `allowed` if and only if no
live matching deny-Grant reaches the target. -/
theorem authority_decision_is_deny_precedence {input : AuthorityInput}
    {backing : AuthorityGrant} (sound : BackingSound input backing)
    (permitted : ¬ (input.guest = true ∧ input.request.intent.impact.elevating = true)) :
    evaluateExec input = .allowed ↔ ¬ LiveDenying input.grants input.request := by
  refine ⟨fun allowed => (authority_decision_is_sound allowed).2, fun absent => ?_⟩
  simp only [evaluateExec, if_pos (denials_empty_iff.mpr absent), if_neg permitted, sound.lookup,
    if_pos sound.allow, if_pos sound.live,
    if_pos (authority_grant_matches_iff.mpr sound.admits), sound.lineage]

/-- **The decision is SPEC §3.3, both directions.** Under a sound Binding and a permitted
guest impact, the resolver admits exactly the requests §3.3 says carry effective
authority. -/
theorem authority_decision_iff_effective {input : AuthorityInput} {backing : AuthorityGrant}
    (sound : BackingSound input backing)
    (permitted : ¬ (input.guest = true ∧ input.request.intent.impact.elevating = true)) :
    evaluateExec input = .allowed ↔ EffectiveAuthority input.grants input.request :=
  ⟨authority_decision_is_sound,
   fun effective => (authority_decision_is_deny_precedence sound permitted).mpr effective.2⟩

/-- **A guest never reaches a delegating or administering impact.** The prohibition is
decided before the Binding's Grant is consulted, so no Grant can restore it (§3.3,
C13-AUTH-GUEST-ELEVATION). -/
theorem guest_elevation_is_refused {input : AuthorityInput} (guest : input.guest = true)
    (elevating : input.request.intent.impact.elevating = true) :
    evaluateExec input ≠ .allowed := by
  unfold evaluateExec
  split
  · rw [if_pos ⟨guest, elevating⟩]; simp
  · simp

/-- **An admitted request admits nothing its Binding's lineage root would refuse.** The
decision, the lineage walk, and SPEC §3.4 rule 2 compose: the intent the resolver admitted
is one every ancestor of the backing Grant admits too. -/
theorem admitted_intent_is_admitted_by_every_ancestor {input : AuthorityInput}
    {backing ancestor : AuthorityGrant} (allowed : evaluateExec input = .allowed)
    (lookup : lookupGrant input.grants input.backing = some backing)
    (ancestry : LineageAncestor input.grants backing ancestor) :
    ancestor.capability.Matches input.request.intent := by
  obtain ⟨_, found, sound⟩ := allowed_names_sound_backing allowed
  have same : found = backing := Option.some.inj (sound.lookup.symm.trans lookup)
  subst same
  exact lineage_ok_ancestor_covers sound.lineage ancestry _ sound.admits.2.2

end AgentCore
