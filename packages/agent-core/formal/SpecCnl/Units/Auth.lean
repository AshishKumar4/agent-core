import SpecCnl.Unit

/-!
# Auth: reviewed pairings for §3.3, §3.4, and §1.4

The rule units here are about how authority comes to exist and how it is refused: a
Membership assigns a Role, the Role's rules materialize into durable Grants keyed by
`(membership, rule ordinal)`, a Binding names an allow-Grant-backed Facet instance, and
one deny anywhere on the ordered Tenant-to-target path defeats every allow below it.
Guests are the same mechanism with two prohibitions bolted on — no `delegate`, no
`administer`, and no materialization while still stamped with the bootstrap scheme — and
mediated authority adds one final admission point that recompares canonical authority and
current path epochs.

Three weaknesses run through the whole group and are recorded on every record they touch
rather than once here.

* **Structural clauses are vacuous, so they are dropped rather than rendered.** A rule
  unit that fixes a record's field list — `PrincipalRef` is `{ tenant, id }`, a
  `CapabilitySpec` is a pattern plus Operations plus constraints — states something the
  model has by construction, so a controlled sentence about it would be true of any model
  with those fields and would discriminate nothing.
* **Refusals are carried as the preconditions every admitted step satisfies.** The model
  has no rejection path and no temporal operator, so "MUST be denied" becomes "every step
  that exists satisfies the positive condition". The two are contrapositives, and the
  named model theorem in the negative form is cited wherever that swap is made.
* **`every role materialization` hides the Role.** The corpus's existing transition family
  is `fun before membership after => ∃ role, MaterializationStep before membership role
  after`, so a postcondition about a materialized Grant can only bind the Role
  existentially. Where that weakens a clause it is said so on the record.
-/

namespace SpecCnl.Corpus.Units.Auth

def units : List RuleUnit :=
  [ { key := "C13_AUTH_DENY_PRECEDENCE"
      atoms := ["C13-AUTH-DENY-PRECEDENCE"]
      specSection := "3.3"
      anchor := "SPEC.md:314"
      digest := "58327e2b1da802d9afc0a1c5a7c900db6abb8832e9e034d8e9d711d086eba467"
      sentence := "every admitted authority decision has effective authority"
      dropped :=
        [ "the converse direction. AgentCore.authority_decision_is_deny_precedence proves \
           the decision is *exactly* deny precedence, but only under a `BackingSound` \
           Binding and a permitted guest impact, and the grammar has no form for a \
           sentence whose subject carries a dependent witness. The sentence carries the \
           soundness half — the decision never allows where §3.3 refuses — which is the \
           security-relevant direction",
          "'a descendant allow MUST NOT re-widen an ancestor deny' as a claim about \
           composition through an intermediate Scope. AgentCore.EffectiveAuthority \
           matches a deny by AgentCore.ScopeReaches from the deny's own Scope to the \
           target, so the sentence carries the flat reach form; \
           AgentCore.ancestor_deny_defeats_descendant_allow is where the composed form \
           lives",
          "'Direct and team Grants are considered together': AgentCore.AuthorityRequest \
           carries one subject list, so the union is structural and a rendering would be \
           vacuous",
          "'an allow-Grant matches a ForeignPrincipalRef exactly, verifiedVia included', \
           and the deny side matching on `{ homeTenant, principalId }`. The asymmetry is \
           AgentCore.allow_requires_exact_verification_scheme and \
           AgentCore.deny_survives_verification_scheme_change; both are negative \
           existentials over a request whose subject list is fixed to one element, and \
           the grammar has no form for a sentence about one instantiated request",
          "the Team-A-on-Project-P example, which is an illustration rather than a rule" ] },
    { key := "C13_AUTH_GUEST_ELEVATION"
      atoms := ["C13-AUTH-GUEST-ELEVATION"]
      specSection := "3.3"
      anchor := "SPEC.md:333"
      digest := "7717d48dc16b77c72ad877726738502f630780ad33b2da13834ec33b5f379e8f"
      sentence :=
        "every elevating guest request is refused and every role materialization \
         establishes attenuated guest grants"
      dropped :=
        [ "'Sharing is Membership issuance — there is no second mechanism', and the \
           Project/team/Team-Membership examples: an exhaustiveness claim over the \
           specification's own mechanisms, which is not a statable property of the model",
          "'every member inherits access by default': AgentCore.AuthorityLedger.ActsUnder \
           reads AgentCore.AuthorityLedger.teamMembers for a team subject, so inheritance \
           is by construction there and a rendering would be vacuous",
          "'MUST NOT resolve the host Tenant's credentials' and 'Credential custody never \
           leaves the owning Tenant': the secret plane owns those, and \
           C13-AUTH-SECRET-SCOPE is where the custody rule is bridged",
          "'Guest-materialized Grants are always attenuated' in the lineage sense — a \
           guest Grant carrying an attenuation parent. AgentCore.grantOfRoleRule sets \
           `parent := none` for every materialized Grant, so the second clause carries \
           the impact prohibition (no `delegate`, no `administer` allow) and not a \
           lineage claim",
          "'The same Grant precedence and Binding resolver apply to guests', which is a \
           claim that no separate code path exists rather than a property of a step" ] },
    { key := "C13_AUTH_GUEST_HANDSHAKE_BOOTSTRAP"
      atoms := ["C13-AUTH-GUEST-HANDSHAKE-BOOTSTRAP"]
      specSection := "3.3"
      anchor := "SPEC.md:388"
      digest := "a00b11a31d000ee6bd3f36c1b5c1ca8f83362645eddcd46ab987c31a2532921c"
      sentence := "every role materialization requires a completed verification scheme"
      dropped :=
        [ "the one-time exchange itself — the home Tenant's owner approving the link and \
           the host recording the resulting trust configuration. The model has no \
           approval step and no trust-configuration record, so the exchange is \
           unrepresentable and only its consequence at materialization is carried",
          "'downgrades all future verifications to token': the model has no transition \
           that rewrites a subject's stamp, so nothing connects one materialization's \
           scheme to a later one's",
          "'steady state is always token or callback' as a claim about reachable states \
           over a whole trace rather than about one step. \
           AgentCore.GuestScheme.completed admits exactly those two, so the sentence \
           carries the per-step consequence",
          "the sentence is the positive precondition every admitted materialization \
           satisfies rather than the refusal the atom words it as. The two are \
           contrapositives in the model and \
           AgentCore.handshake_guest_never_materializes is the refusal form" ] },
    { key := "C13_AUTH_PRINCIPAL_REF"
      atoms := ["C13-AUTH-PRINCIPAL-REF"]
      specSection := "1.4"
      anchor := "SPEC.md:106"
      digest := "fb3a224b528b0d0752f9d7f5cebab7c2f9957e51094844325d7f75fa02841b88"
      sentence :=
        "every authority resolution requires a tenant qualified principal for the \
         resolution and the acting principal subject assigns at most one value"
      dropped :=
        [ "'PrincipalRef is always tenant-qualified: { tenant: TenantId, id: PrincipalId }'. \
           AgentCore.PrincipalRef carries exactly those two fields, so a rendering of the \
           shape clause would be true by construction and therefore vacuous. What the \
           sentence carries is the two consequences that discriminate: an issued \
           resolution's Principal belongs to the target Scope's own Tenant, and a caller \
           acts under exactly one Principal subject",
          "'Identifiers ending in Id or Name are opaque, codec-stable identifier types', \
           and the enumeration of simple reference types: a claim about the type \
           vocabulary of the specification document, not about the model",
          "'SubjectRef is the PrincipalRef | Team | ForeignPrincipalRef union': \
           AgentCore.Subject is exactly that three-way inductive, so the union clause is \
           structural and a rendering would be vacuous",
          "'Every caller, authority initiator or delegate, lease holder, route initiator, \
           cross-Actor permit, and Membership or Grant subject carries this canonical \
           form' as an exhaustive claim over carriers. AgentCore.AuthoritySource, \
           AgentCore.LeaseToken, AgentCore.Membership and AgentCore.Grant all name the \
           record by field, so the carrier list is structural; the sentence quantifies \
           over the one carrier a transition reads, the issued resolution",
          "'an unqualified id' as a distinct failure from a mismatched Tenant: the model \
           has no unqualified identifier to reject, since AgentCore.PrincipalRef cannot \
           be built without a Tenant" ] },
    { key := "C13_AUTH_PLANE"
      atoms := ["C13-AUTH-PLANE"]
      specSection := "3.3"
      anchor := "SPEC.md:303"
      digest := "1a40ff2029690cd891e948abd8809f705da5bcaadfcdd12c5d9096b322047a61"
      sentence :=
        "every role materialization establishes membership assigned grants only and every \
         role materialization establishes an advanced scope epoch"
      dropped :=
        [ "'A Membership is not itself callable authority' and 'The enforcement plane MUST \
           resolve only Grants and Bindings; Roles and Memberships have no second path' \
           as exhaustiveness claims over the resolver. \
           AgentCore.AuthorityLedger.Authorized reads Bindings and Grants and nothing \
           Role-shaped, but that is a property of the definition rather than of a \
           transition, so the sentence carries the writing side instead: a \
           materialization introduces no Grant outside the assigning Membership's own key \
           space",
          "'idempotently, exactly as a Blueprint materializes records' and 'Reapplying the \
           same Role reconciles those Grants rather than adding authority'. \
           AgentCore.materializeRole computes the Grant at `(membership, ordinal)` from \
           the Role alone and never reads the previous table there, so idempotence is a \
           property of the function rather than of the step relation, and the first \
           clause carries only the never-writes-elsewhere half",
          "'Downward flow, attenuation, and revocation MUST operate only on Grants': \
           C13-AUTH-BINDING-RESOLUTION carries the attenuation half over \
           AgentCore.AuthorityLedger.AuthorityStep's delegate label",
          "'Revoking or changing a Membership revokes its obsolete materialized Grants'. \
           THE SENTENCE IS WEAKER THAN THE ATOM. The model has no membership-revocation \
           label, so nothing removes a stale `(membership, ordinal)` Grant; \
           AgentCore.materializeRole overwrites the ordinals the new Role covers and \
           leaves any higher ordinal a shorter rule list no longer reaches. The second \
           clause carries the epoch advance the same rule requires, which is the part \
           §3.4 keys staleness on",
          "'A guest Membership materializes the same way after removing all allow rules \
           that…': C13-AUTH-GUEST-ELEVATION carries the guest filter" ] },
    { key := "C13_AUTH_ROLE_MATERIALIZATION"
      atoms := ["C13-AUTH-ROLE-MATERIALIZATION"]
      specSection := "3.3"
      anchor := "SPEC.md:291"
      digest := "fbe4983dc3741e73ff3b410fd9e1edb32bb4c5ca7be99aae8646a1f981a2aa6c"
      sentence := "every role materialization establishes rule ordinal keyed grants"
      dropped :=
        [ "'A CapabilitySpec describes one grantable authority: a Facet or Facet pattern, \
           the Operations (or Operation impacts) it covers, and any argument \
           constraints'. AgentCore.Capability carries exactly a pattern, an Operation \
           list, an impact list, and a constraint list, so a rendering of the shape \
           clause would be true by construction and therefore vacuous",
          "'any matching deny overrides every matching allow', which is \
           C13-AUTH-DENY-PRECEDENCE and is carried by that record",
          "'the spec fixes three built-in roles every platform provides — owner, editor, \
           reader': the model has no built-in Role table, so the three are \
           unrepresentable, and 'platforms MAY declare more rules including denies' is a \
           MAY",
          "'Roles are declared in a Blueprint (policies.roles) or supplied by a Package': \
           the model has no Blueprint record and no Package, so declaration provenance \
           has nothing to range over",
          "the Role's identity is existential in the sentence, because the corpus's \
           materialization family binds the Role with `∃ role`. The clause therefore \
           fixes the Membership and the ordinal a materialized Grant records and not \
           which RoleId it came from; a materialization that recorded the wrong RoleId at \
           the right ordinal would pass",
          "'A Role is a template; it becomes authority only when a Membership assigns it' \
           in the exhaustive direction, which C13-AUTH-PLANE's first clause carries" ] },
    { key := "C13_AUTH_BINDING_RESOLUTION"
      atoms := ["C13-AUTH-BINDING-RESOLUTION"]
      specSection := "3.4"
      anchor := "SPEC.md:407"
      digest := "4835ea38e8de1c5da71190c50b32b058ce13d11cbd55aee0c472a335025db599"
      sentence :=
        "every grant delegation establishes a contained allow for the delegation and every \
         authority resolution requires an exact facet binding for the resolution"
      dropped :=
        [ "'A Grant is a durable authority rule: subject, Scope, allow | deny effect, \
           capability, origin, attenuation lineage, and revocation state'. AgentCore.Grant \
           carries exactly those, so the shape clause is structural and a rendering would \
           be vacuous",
          "'an equal or narrower capability' in the semantic sense. The model's abstract \
           Grant plane compares permissions for equality and Scopes for containment, \
           while AgentCore.Capability.Covers — containment of admitted intents over the \
           whole infinite intent domain — lives on the separate resolver plane of \
           AgentCore.Authority. The first clause carries the equal-permission, \
           contained-Scope form the delegation step enforces; \
           AgentCore.lineage_ok_ancestor_covers is where the semantic form at every depth \
           of the lineage lives",
          "'a deny is not callable or delegable' as a refusal. \
           AgentCore.AuthorityLedger.AuthorityStep's delegate constructor admits only an \
           allow child under an allow parent, so the sentence carries the positive form \
           and the refusal is its contrapositive",
          "'A Binding associates a subject-local name with an allow-Grant-backed Facet \
           instance in one protection domain': the name is carried by \
           AgentCore.Binding.name and constrained nowhere, so the subject-local naming \
           clause has nothing to range over — see the unbridged \
           C13-AUTH-BINDING-NAME-CANONICAL",
          "'Binding resolution evaluates all matching allow and deny Grants through §3.3 \
           precedence. There is no deny list or role check beside this plane': \
           C13-AUTH-DENY-PRECEDENCE carries the precedence, and the no-second-plane \
           clause is an exhaustiveness claim over the resolver",
          "'Callable access requires a ResolvedFacet produced by that resolver; \
           identifiers alone confer nothing': the model has no ResolvedFacet record, so \
           the second clause carries the Binding-to-Facet match \
           AgentCore.AuthorityLedger.Authorized enforces instead",
          "'an Invocation whose Operation belongs to another Facet MUST NOT be authorized \
           by it' as a refusal, which is the contrapositive of the exact-Facet clause the \
           sentence carries" ] },
    { key := "C13_AUTH_MEDIATED_STALE"
      atoms := ["C13-AUTH-MEDIATED-STALE", "C13-AUTH-MEDIATED-ADMISSION"]
      specSection := "3.4"
      anchor := "SPEC.md:515"
      digest := "1853c817860bfe712e7d3133aa65ccf01b6a942874b4f2daf904aa5712744c04"
      sentence :=
        "every mediated start requires a current authority path for the started intent and \
         every stale mediated denial establishes a matched denial for the denied receipt"
      dropped :=
        [ "'Cross-Actor mediation performs that final comparison in the authoritative \
           Tenant Actor', and 'issuing the §10.3 AuthorityPermit is the final \
           authority-admission linearization point immediately before target attempt \
           admission'. AgentCore.MediatedStep is Actor-local, so the sentence carries the \
           Actor-local admission point; the permit plane is AgentCore.DistributedPermit \
           and no transition family of this corpus ranges over it",
          "'only after the exact target claim, target fence, reservation epoch, item key, \
           ordinal, arguments digest, and whole intent are known' as an ordering claim. \
           The model has no temporal operator, so the sentence renders the conjunction as \
           the source-state precondition the admitting step satisfies",
          "'Permit issuance linearizes against Grant, Binding-generation, and path-epoch \
           mutation', and 'Revocation committed before issuance blocks the permit; \
           revocation committed after issuance cannot cancel the already admitted \
           attempt': the model has no permit issuance in this ledger and no ordering \
           between a revocation and an admission, so what is carried is that an admitted \
           start read a complete, current path evidence set — \
           AgentCore.AuthorityLedger.bump_scope_stales_path_evidence is what makes that \
           condition fail after a mutation",
          "the target Scope of the recompared authority is existential in the first \
           clause, because AgentCore.MediatedLabel.start carries only the Invocation. \
           AgentCore.AuthorityLedger.PathEvidenceComplete pins it to the header's own \
           path evidence, so the existential is determined for any header carrying \
           evidence, but a header with an empty evidence list would satisfy the clause at \
           a Scope of the wrong depth",
          "the second clause is about the model's own stale-denial label rather than about \
           every stale request: it says what a recorded stale denial is (a denied \
           pre-effect receipt naming a prepared item of the exact persisted intent), not \
           that every staleness is denied" ] },
    { key := "C13_AUTH_RESOLUTION_LIFETIME"
      atoms := ["C13-AUTH-RESOLUTION-LIFETIME"]
      specSection := "3.4"
      anchor := "SPEC.md:528"
      digest := "b3f02fa9a77980e6f2c8fa94ef5613d1170aacc72e770e0365b7ba8356b701db"
      sentence :=
        "every authority resolution requires the stated deadline is at most the bounded \
         window for the resolution and every authority resolution requires an exact lease \
         expiry for the resolution"
      dropped :=
        [ "'Resolved-facet lifetime follows the isolation mode' as a case split on the \
           mode. AgentCore.Resolution carries no placement, so the model has one \
           resolution lifetime rather than three, and the sentence bounds that one",
          "'provider/dynamic resolutions last one Turn step' and the definition of a Turn \
           step as the interval between two firings of the turn.step cut point: the model \
           has no Turn-step interval and no interceptor cut point, so a per-step lifetime \
           has nothing to range over",
          "'a held or cached resolution admits only while it still names the exact \
           current LeaseToken for that Turn'. THE SENTENCE IS WEAKER THAN THE ATOM. The \
           sentence bounds the issued deadline by the incarnation's own recorded expiry, \
           which is what makes fencing or reclaiming end the resolution; the \
           exact-token-at-use check is \
           AgentCore.AuthorityLedger.DirectResolutionUsable together with \
           AgentCore.ExactLeaseGate, and neither is a condition on this transition's \
           source state",
          "'so fencing, reclaiming, or completing the Turn ends it at once rather than at \
           the next unrelated check': an eventuality about later checks, which a \
           source-state precondition cannot carry",
          "'the capability stub they wrap MUST NOT be held or reused past the step in \
           which it was obtained': the model has no capability stub" ] }]

end SpecCnl.Corpus.Units.Auth
