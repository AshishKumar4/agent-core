// @ts-nocheck
function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
import type { ActorRef } from "../actors";
import { AgentCoreError } from "../errors";
import type { CapabilityIntent } from "../facets";
import type { Principal, PrincipalId, GuestTrust, GuestTrustId, Membership, MembershipId, ScopeRef, Team, TenantId, WorkspaceId, Workspace } from "../identity";
import { SubjectRef as Subjects } from "../identity";
import type { BindingValidationRequest } from "./binding-evidence";
import { BindingValidationEvidence } from "./binding-evidence";
import { AuthorityCheckEvidence, type AuthorityCheckRequest, type AuthorityDecisionReason } from "./evidence";
import { PathEpochEvidence, type ScopeEpoch } from "./epoch";
import type { Grant } from "./grant";
import type { GrantId } from "./id";
import { scopeKey, subjectKey } from "./reference";
export interface TenantAuthorityReadStore {
  readonly tenantId: TenantId;
  principal(id: PrincipalId): Principal | undefined;
  teams(): readonly Team[];
  workspace(id: WorkspaceId): Workspace | undefined;
  membership(id: MembershipId): Membership | undefined;
  guestTrust(id: GuestTrustId): GuestTrust | undefined;
  grant(id: GrantId): Grant | undefined;
  grants(): readonly Grant[];
  epoch(scope: ScopeRef): ScopeEpoch;
}
export class TenantAuthorityRuntime {
  public constructor(private readonly store: TenantAuthorityReadStore, private readonly issuer: ActorRef) {
    if (stryMutAct_9fa48("3304")) {
      {}
    } else {
      stryCov_9fa48("3304");
      if (stryMutAct_9fa48("3307") ? issuer.kind === "tenant" : stryMutAct_9fa48("3306") ? false : stryMutAct_9fa48("3305") ? true : (stryCov_9fa48("3305", "3306", "3307"), issuer.kind !== (stryMutAct_9fa48("3308") ? "" : (stryCov_9fa48("3308"), "tenant")))) {
        if (stryMutAct_9fa48("3309")) {
          {}
        } else {
          stryCov_9fa48("3309");
          throw new AgentCoreError(stryMutAct_9fa48("3310") ? "" : (stryCov_9fa48("3310"), "protocol.invalid-state"), stryMutAct_9fa48("3311") ? "" : (stryCov_9fa48("3311"), "Tenant authority runtime requires a Tenant Actor"));
        }
      }
    }
  }
  public validateBinding(request: BindingValidationRequest, now: Date): BindingValidationEvidence {
    if (stryMutAct_9fa48("3312")) {
      {}
    } else {
      stryCov_9fa48("3312");
      this.requireTenant(request.ownerTenant);
      const workspace = this.requireWorkspace(request.scope);
      const grant = this.store.grant(request.grantId);
      if (stryMutAct_9fa48("3315") ? (grant === undefined || !grant.isLive || grant.effect !== "allow" || !scopeReaches(grant.scope, workspace.scope) || validateLineage(grant, this.store.grants(), workspace.scope.path) !== undefined) && !this.guestGrantIsCurrent(grant, now) : stryMutAct_9fa48("3314") ? false : stryMutAct_9fa48("3313") ? true : (stryCov_9fa48("3313", "3314", "3315"), (stryMutAct_9fa48("3317") ? (grant === undefined || !grant.isLive || grant.effect !== "allow" || !scopeReaches(grant.scope, workspace.scope)) && validateLineage(grant, this.store.grants(), workspace.scope.path) !== undefined : stryMutAct_9fa48("3316") ? false : (stryCov_9fa48("3316", "3317"), (stryMutAct_9fa48("3319") ? (grant === undefined || !grant.isLive || grant.effect !== "allow") && !scopeReaches(grant.scope, workspace.scope) : stryMutAct_9fa48("3318") ? false : (stryCov_9fa48("3318", "3319"), (stryMutAct_9fa48("3321") ? (grant === undefined || !grant.isLive) && grant.effect !== "allow" : stryMutAct_9fa48("3320") ? false : (stryCov_9fa48("3320", "3321"), (stryMutAct_9fa48("3323") ? grant === undefined && !grant.isLive : stryMutAct_9fa48("3322") ? false : (stryCov_9fa48("3322", "3323"), (stryMutAct_9fa48("3325") ? grant !== undefined : stryMutAct_9fa48("3324") ? false : (stryCov_9fa48("3324", "3325"), grant === undefined)) || (stryMutAct_9fa48("3326") ? grant.isLive : (stryCov_9fa48("3326"), !grant.isLive)))) || (stryMutAct_9fa48("3328") ? grant.effect === "allow" : stryMutAct_9fa48("3327") ? false : (stryCov_9fa48("3327", "3328"), grant.effect !== (stryMutAct_9fa48("3329") ? "" : (stryCov_9fa48("3329"), "allow")))))) || (stryMutAct_9fa48("3330") ? scopeReaches(grant.scope, workspace.scope) : (stryCov_9fa48("3330"), !scopeReaches(grant.scope, workspace.scope))))) || (stryMutAct_9fa48("3332") ? validateLineage(grant, this.store.grants(), workspace.scope.path) === undefined : stryMutAct_9fa48("3331") ? false : (stryCov_9fa48("3331", "3332"), validateLineage(grant, this.store.grants(), workspace.scope.path) !== undefined)))) || (stryMutAct_9fa48("3333") ? this.guestGrantIsCurrent(grant, now) : (stryCov_9fa48("3333"), !this.guestGrantIsCurrent(grant, now))))) {
        if (stryMutAct_9fa48("3334")) {
          {}
        } else {
          stryCov_9fa48("3334");
          throw authorityDenied(stryMutAct_9fa48("3335") ? "" : (stryCov_9fa48("3335"), "Binding requires a live allow Grant reaching its Workspace"));
        }
      }
      return new BindingValidationEvidence(this.store.tenantId, this.issuer, request.digest(), workspace.scope, grant.subject, grant.id, this.currentPath(workspace), now);
    }
  }
  public check(request: AuthorityCheckRequest, now: Date): AuthorityCheckEvidence {
    if (stryMutAct_9fa48("3336")) {
      {}
    } else {
      stryCov_9fa48("3336");
      this.requireTenant(request.ownerTenant);
      const workspace = this.requireWorkspace(request.binding.scope);
      const currentPath = this.currentPath(workspace);
      const stale = stryMutAct_9fa48("3337") ? request.expectedPath.equals(currentPath) : (stryCov_9fa48("3337"), !request.expectedPath.equals(currentPath));
      const result = stale ? stryMutAct_9fa48("3338") ? {} : (stryCov_9fa48("3338"), {
        reason: "stalePath" as const,
        allow: [] as Grant[],
        deny: [] as Grant[]
      }) : this.evaluate(request, workspace.scope.path, now);
      return new AuthorityCheckEvidence(this.store.tenantId, this.issuer, request.digest(), request.binding.key, request.binding.generation, (stryMutAct_9fa48("3341") ? result.reason !== "allowed" : stryMutAct_9fa48("3340") ? false : stryMutAct_9fa48("3339") ? true : (stryCov_9fa48("3339", "3340", "3341"), result.reason === (stryMutAct_9fa48("3342") ? "" : (stryCov_9fa48("3342"), "allowed")))) ? stryMutAct_9fa48("3343") ? "" : (stryCov_9fa48("3343"), "allow") : stryMutAct_9fa48("3344") ? "" : (stryCov_9fa48("3344"), "deny"), result.reason, result.allow.map(stryMutAct_9fa48("3345") ? () => undefined : (stryCov_9fa48("3345"), grant => grant.id)), result.deny.map(stryMutAct_9fa48("3346") ? () => undefined : (stryCov_9fa48("3346"), grant => grant.id)), currentPath, now);
    }
  }
  private evaluate(request: AuthorityCheckRequest, exactPath: readonly ScopeRef[], now: Date): {
    readonly reason: AuthorityDecisionReason;
    readonly allow: readonly Grant[];
    readonly deny: readonly Grant[];
  } {
    if (stryMutAct_9fa48("3347")) {
      {}
    } else {
      stryCov_9fa48("3347");
      if (stryMutAct_9fa48("3350") ? !request.binding.resolves && !request.binding.scope.equals(exactPath[exactPath.length - 1]!) : stryMutAct_9fa48("3349") ? false : stryMutAct_9fa48("3348") ? true : (stryCov_9fa48("3348", "3349", "3350"), (stryMutAct_9fa48("3351") ? request.binding.resolves : (stryCov_9fa48("3351"), !request.binding.resolves)) || (stryMutAct_9fa48("3352") ? request.binding.scope.equals(exactPath[exactPath.length - 1]!) : (stryCov_9fa48("3352"), !request.binding.scope.equals(exactPath[stryMutAct_9fa48("3353") ? exactPath.length + 1 : (stryCov_9fa48("3353"), exactPath.length - 1)]!))))) {
        if (stryMutAct_9fa48("3354")) {
          {}
        } else {
          stryCov_9fa48("3354");
          return stryMutAct_9fa48("3355") ? {} : (stryCov_9fa48("3355"), {
            reason: stryMutAct_9fa48("3356") ? "" : (stryCov_9fa48("3356"), "invalidBinding"),
            allow: stryMutAct_9fa48("3357") ? ["Stryker was here"] : (stryCov_9fa48("3357"), []),
            deny: stryMutAct_9fa48("3358") ? ["Stryker was here"] : (stryCov_9fa48("3358"), [])
          });
        }
      }
      const subjects = this.effectiveSubjects(request);
      if (stryMutAct_9fa48("3361") ? subjects !== undefined : stryMutAct_9fa48("3360") ? false : stryMutAct_9fa48("3359") ? true : (stryCov_9fa48("3359", "3360", "3361"), subjects === undefined)) {
        if (stryMutAct_9fa48("3362")) {
          {}
        } else {
          stryCov_9fa48("3362");
          return stryMutAct_9fa48("3363") ? {} : (stryCov_9fa48("3363"), {
            reason: stryMutAct_9fa48("3364") ? "" : (stryCov_9fa48("3364"), "missingPrincipal"),
            allow: stryMutAct_9fa48("3365") ? ["Stryker was here"] : (stryCov_9fa48("3365"), []),
            deny: stryMutAct_9fa48("3366") ? ["Stryker was here"] : (stryCov_9fa48("3366"), [])
          });
        }
      }
      if (stryMutAct_9fa48("3368") ? false : stryMutAct_9fa48("3367") ? true : (stryCov_9fa48("3367", "3368"), request.principal.tenantId.equals(this.store.tenantId))) {
        if (stryMutAct_9fa48("3369")) {
          {}
        } else {
          stryCov_9fa48("3369");
          const principal = this.store.principal(request.principal.principalId);
          if (stryMutAct_9fa48("3372") ? principal !== undefined : stryMutAct_9fa48("3371") ? false : stryMutAct_9fa48("3370") ? true : (stryCov_9fa48("3370", "3371", "3372"), principal === undefined)) return stryMutAct_9fa48("3373") ? {} : (stryCov_9fa48("3373"), {
            reason: stryMutAct_9fa48("3374") ? "" : (stryCov_9fa48("3374"), "missingPrincipal"),
            allow: stryMutAct_9fa48("3375") ? ["Stryker was here"] : (stryCov_9fa48("3375"), []),
            deny: stryMutAct_9fa48("3376") ? ["Stryker was here"] : (stryCov_9fa48("3376"), [])
          });
          if (stryMutAct_9fa48("3379") ? false : stryMutAct_9fa48("3378") ? true : stryMutAct_9fa48("3377") ? principal.canAct : (stryCov_9fa48("3377", "3378", "3379"), !principal.canAct)) return stryMutAct_9fa48("3380") ? {} : (stryCov_9fa48("3380"), {
            reason: stryMutAct_9fa48("3381") ? "" : (stryCov_9fa48("3381"), "inactivePrincipal"),
            allow: stryMutAct_9fa48("3382") ? ["Stryker was here"] : (stryCov_9fa48("3382"), []),
            deny: stryMutAct_9fa48("3383") ? ["Stryker was here"] : (stryCov_9fa48("3383"), [])
          });
        }
      }
      const intent: CapabilityIntent = stryMutAct_9fa48("3384") ? {} : (stryCov_9fa48("3384"), {
        facet: request.intent.facet.value,
        operation: request.intent.operation,
        impact: request.intent.impact,
        arguments: request.intent.arguments
      });
      const path = new Set(exactPath.map(scopeKey));
      const all = this.store.grants();
      const relevant = stryMutAct_9fa48("3385") ? all : (stryCov_9fa48("3385"), all.filter(stryMutAct_9fa48("3386") ? () => undefined : (stryCov_9fa48("3386"), grant => stryMutAct_9fa48("3389") ? subjects.has(subjectKey(grant.subject)) && path.has(scopeKey(grant.scope)) || grant.capability.matches(intent) : stryMutAct_9fa48("3388") ? false : stryMutAct_9fa48("3387") ? true : (stryCov_9fa48("3387", "3388", "3389"), (stryMutAct_9fa48("3391") ? subjects.has(subjectKey(grant.subject)) || path.has(scopeKey(grant.scope)) : stryMutAct_9fa48("3390") ? true : (stryCov_9fa48("3390", "3391"), subjects.has(subjectKey(grant.subject)) && path.has(scopeKey(grant.scope)))) && grant.capability.matches(intent)))));
      const deny = stryMutAct_9fa48("3392") ? relevant : (stryCov_9fa48("3392"), relevant.filter(stryMutAct_9fa48("3393") ? () => undefined : (stryCov_9fa48("3393"), grant => stryMutAct_9fa48("3396") ? grant.isLive || grant.effect === "deny" : stryMutAct_9fa48("3395") ? false : stryMutAct_9fa48("3394") ? true : (stryCov_9fa48("3394", "3395", "3396"), grant.isLive && (stryMutAct_9fa48("3398") ? grant.effect !== "deny" : stryMutAct_9fa48("3397") ? true : (stryCov_9fa48("3397", "3398"), grant.effect === (stryMutAct_9fa48("3399") ? "" : (stryCov_9fa48("3399"), "deny"))))))));
      if (stryMutAct_9fa48("3403") ? deny.length <= 0 : stryMutAct_9fa48("3402") ? deny.length >= 0 : stryMutAct_9fa48("3401") ? false : stryMutAct_9fa48("3400") ? true : (stryCov_9fa48("3400", "3401", "3402", "3403"), deny.length > 0)) return stryMutAct_9fa48("3404") ? {} : (stryCov_9fa48("3404"), {
        reason: stryMutAct_9fa48("3405") ? "" : (stryCov_9fa48("3405"), "matchingDeny"),
        allow: stryMutAct_9fa48("3406") ? ["Stryker was here"] : (stryCov_9fa48("3406"), []),
        deny
      });
      const guest = stryMutAct_9fa48("3407") ? request.principal.tenantId.equals(this.store.tenantId) : (stryCov_9fa48("3407"), !request.principal.tenantId.equals(this.store.tenantId));
      if (stryMutAct_9fa48("3410") ? guest || request.intent.impact === "delegate" || request.intent.impact === "administer" : stryMutAct_9fa48("3409") ? false : stryMutAct_9fa48("3408") ? true : (stryCov_9fa48("3408", "3409", "3410"), guest && (stryMutAct_9fa48("3412") ? request.intent.impact === "delegate" && request.intent.impact === "administer" : stryMutAct_9fa48("3411") ? true : (stryCov_9fa48("3411", "3412"), (stryMutAct_9fa48("3414") ? request.intent.impact !== "delegate" : stryMutAct_9fa48("3413") ? false : (stryCov_9fa48("3413", "3414"), request.intent.impact === (stryMutAct_9fa48("3415") ? "" : (stryCov_9fa48("3415"), "delegate")))) || (stryMutAct_9fa48("3417") ? request.intent.impact !== "administer" : stryMutAct_9fa48("3416") ? false : (stryCov_9fa48("3416", "3417"), request.intent.impact === (stryMutAct_9fa48("3418") ? "" : (stryCov_9fa48("3418"), "administer")))))))) {
        if (stryMutAct_9fa48("3419")) {
          {}
        } else {
          stryCov_9fa48("3419");
          return stryMutAct_9fa48("3420") ? {} : (stryCov_9fa48("3420"), {
            reason: stryMutAct_9fa48("3421") ? "" : (stryCov_9fa48("3421"), "guestElevation"),
            allow: stryMutAct_9fa48("3422") ? ["Stryker was here"] : (stryCov_9fa48("3422"), []),
            deny: stryMutAct_9fa48("3423") ? ["Stryker was here"] : (stryCov_9fa48("3423"), [])
          });
        }
      }
      const backing = this.store.grant(request.binding.grantId);
      if (stryMutAct_9fa48("3426") ? backing === undefined && backing.effect !== "allow" : stryMutAct_9fa48("3425") ? false : stryMutAct_9fa48("3424") ? true : (stryCov_9fa48("3424", "3425", "3426"), (stryMutAct_9fa48("3428") ? backing !== undefined : stryMutAct_9fa48("3427") ? false : (stryCov_9fa48("3427", "3428"), backing === undefined)) || (stryMutAct_9fa48("3430") ? backing.effect === "allow" : stryMutAct_9fa48("3429") ? false : (stryCov_9fa48("3429", "3430"), backing.effect !== (stryMutAct_9fa48("3431") ? "" : (stryCov_9fa48("3431"), "allow")))))) {
        if (stryMutAct_9fa48("3432")) {
          {}
        } else {
          stryCov_9fa48("3432");
          return stryMutAct_9fa48("3433") ? {} : (stryCov_9fa48("3433"), {
            reason: stryMutAct_9fa48("3434") ? "" : (stryCov_9fa48("3434"), "missingGrant"),
            allow: stryMutAct_9fa48("3435") ? ["Stryker was here"] : (stryCov_9fa48("3435"), []),
            deny: stryMutAct_9fa48("3436") ? ["Stryker was here"] : (stryCov_9fa48("3436"), [])
          });
        }
      }
      if (stryMutAct_9fa48("3439") ? false : stryMutAct_9fa48("3438") ? true : stryMutAct_9fa48("3437") ? backing.isLive : (stryCov_9fa48("3437", "3438", "3439"), !backing.isLive)) return stryMutAct_9fa48("3440") ? {} : (stryCov_9fa48("3440"), {
        reason: stryMutAct_9fa48("3441") ? "" : (stryCov_9fa48("3441"), "revokedGrant"),
        allow: stryMutAct_9fa48("3442") ? ["Stryker was here"] : (stryCov_9fa48("3442"), []),
        deny: stryMutAct_9fa48("3443") ? ["Stryker was here"] : (stryCov_9fa48("3443"), [])
      });
      if (stryMutAct_9fa48("3446") ? guest || backing.origin.kind !== "role" || !backing.origin.guest || backing.capability.grantsElevation() : stryMutAct_9fa48("3445") ? false : stryMutAct_9fa48("3444") ? true : (stryCov_9fa48("3444", "3445", "3446"), guest && (stryMutAct_9fa48("3448") ? (backing.origin.kind !== "role" || !backing.origin.guest) && backing.capability.grantsElevation() : stryMutAct_9fa48("3447") ? true : (stryCov_9fa48("3447", "3448"), (stryMutAct_9fa48("3450") ? backing.origin.kind !== "role" && !backing.origin.guest : stryMutAct_9fa48("3449") ? false : (stryCov_9fa48("3449", "3450"), (stryMutAct_9fa48("3452") ? backing.origin.kind === "role" : stryMutAct_9fa48("3451") ? false : (stryCov_9fa48("3451", "3452"), backing.origin.kind !== (stryMutAct_9fa48("3453") ? "" : (stryCov_9fa48("3453"), "role")))) || (stryMutAct_9fa48("3454") ? backing.origin.guest : (stryCov_9fa48("3454"), !backing.origin.guest)))) || backing.capability.grantsElevation())))) {
        if (stryMutAct_9fa48("3455")) {
          {}
        } else {
          stryCov_9fa48("3455");
          return stryMutAct_9fa48("3456") ? {} : (stryCov_9fa48("3456"), {
            reason: stryMutAct_9fa48("3457") ? "" : (stryCov_9fa48("3457"), "guestElevation"),
            allow: stryMutAct_9fa48("3458") ? ["Stryker was here"] : (stryCov_9fa48("3458"), []),
            deny: stryMutAct_9fa48("3459") ? ["Stryker was here"] : (stryCov_9fa48("3459"), [])
          });
        }
      }
      if (stryMutAct_9fa48("3462") ? guest || !this.guestGrantIsCurrent(backing, now) : stryMutAct_9fa48("3461") ? false : stryMutAct_9fa48("3460") ? true : (stryCov_9fa48("3460", "3461", "3462"), guest && (stryMutAct_9fa48("3463") ? this.guestGrantIsCurrent(backing, now) : (stryCov_9fa48("3463"), !this.guestGrantIsCurrent(backing, now))))) {
        if (stryMutAct_9fa48("3464")) {
          {}
        } else {
          stryCov_9fa48("3464");
          return stryMutAct_9fa48("3465") ? {} : (stryCov_9fa48("3465"), {
            reason: stryMutAct_9fa48("3466") ? "" : (stryCov_9fa48("3466"), "guestVerificationExpired"),
            allow: stryMutAct_9fa48("3467") ? ["Stryker was here"] : (stryCov_9fa48("3467"), []),
            deny: stryMutAct_9fa48("3468") ? ["Stryker was here"] : (stryCov_9fa48("3468"), [])
          });
        }
      }
      if (stryMutAct_9fa48("3471") ? (!subjects.has(subjectKey(backing.subject)) || subjectKey(backing.subject) !== subjectKey(request.binding.subject) || !path.has(scopeKey(backing.scope)) || request.binding.facet.value !== request.intent.facet.value) && !backing.capability.matches(intent) : stryMutAct_9fa48("3470") ? false : stryMutAct_9fa48("3469") ? true : (stryCov_9fa48("3469", "3470", "3471"), (stryMutAct_9fa48("3473") ? (!subjects.has(subjectKey(backing.subject)) || subjectKey(backing.subject) !== subjectKey(request.binding.subject) || !path.has(scopeKey(backing.scope))) && request.binding.facet.value !== request.intent.facet.value : stryMutAct_9fa48("3472") ? false : (stryCov_9fa48("3472", "3473"), (stryMutAct_9fa48("3475") ? (!subjects.has(subjectKey(backing.subject)) || subjectKey(backing.subject) !== subjectKey(request.binding.subject)) && !path.has(scopeKey(backing.scope)) : stryMutAct_9fa48("3474") ? false : (stryCov_9fa48("3474", "3475"), (stryMutAct_9fa48("3477") ? !subjects.has(subjectKey(backing.subject)) && subjectKey(backing.subject) !== subjectKey(request.binding.subject) : stryMutAct_9fa48("3476") ? false : (stryCov_9fa48("3476", "3477"), (stryMutAct_9fa48("3478") ? subjects.has(subjectKey(backing.subject)) : (stryCov_9fa48("3478"), !subjects.has(subjectKey(backing.subject)))) || (stryMutAct_9fa48("3480") ? subjectKey(backing.subject) === subjectKey(request.binding.subject) : stryMutAct_9fa48("3479") ? false : (stryCov_9fa48("3479", "3480"), subjectKey(backing.subject) !== subjectKey(request.binding.subject))))) || (stryMutAct_9fa48("3481") ? path.has(scopeKey(backing.scope)) : (stryCov_9fa48("3481"), !path.has(scopeKey(backing.scope)))))) || (stryMutAct_9fa48("3483") ? request.binding.facet.value === request.intent.facet.value : stryMutAct_9fa48("3482") ? false : (stryCov_9fa48("3482", "3483"), request.binding.facet.value !== request.intent.facet.value)))) || (stryMutAct_9fa48("3484") ? backing.capability.matches(intent) : (stryCov_9fa48("3484"), !backing.capability.matches(intent))))) {
        if (stryMutAct_9fa48("3485")) {
          {}
        } else {
          stryCov_9fa48("3485");
          return stryMutAct_9fa48("3486") ? {} : (stryCov_9fa48("3486"), {
            reason: stryMutAct_9fa48("3487") ? "" : (stryCov_9fa48("3487"), "noMatchingAllow"),
            allow: stryMutAct_9fa48("3488") ? ["Stryker was here"] : (stryCov_9fa48("3488"), []),
            deny: stryMutAct_9fa48("3489") ? ["Stryker was here"] : (stryCov_9fa48("3489"), [])
          });
        }
      }
      const lineage = validateLineage(backing, all, exactPath);
      if (stryMutAct_9fa48("3492") ? lineage === undefined : stryMutAct_9fa48("3491") ? false : stryMutAct_9fa48("3490") ? true : (stryCov_9fa48("3490", "3491", "3492"), lineage !== undefined)) return stryMutAct_9fa48("3493") ? {} : (stryCov_9fa48("3493"), {
        reason: lineage,
        allow: stryMutAct_9fa48("3494") ? ["Stryker was here"] : (stryCov_9fa48("3494"), []),
        deny: stryMutAct_9fa48("3495") ? ["Stryker was here"] : (stryCov_9fa48("3495"), [])
      });
      const allow = stryMutAct_9fa48("3496") ? relevant : (stryCov_9fa48("3496"), relevant.filter(stryMutAct_9fa48("3497") ? () => undefined : (stryCov_9fa48("3497"), grant => stryMutAct_9fa48("3500") ? grant.effect === "allow" && validateLineage(grant, all, exactPath) === undefined || grant.subject.kind !== "foreign" || this.guestGrantIsCurrent(grant, now) : stryMutAct_9fa48("3499") ? false : stryMutAct_9fa48("3498") ? true : (stryCov_9fa48("3498", "3499", "3500"), (stryMutAct_9fa48("3502") ? grant.effect === "allow" || validateLineage(grant, all, exactPath) === undefined : stryMutAct_9fa48("3501") ? true : (stryCov_9fa48("3501", "3502"), (stryMutAct_9fa48("3504") ? grant.effect !== "allow" : stryMutAct_9fa48("3503") ? true : (stryCov_9fa48("3503", "3504"), grant.effect === (stryMutAct_9fa48("3505") ? "" : (stryCov_9fa48("3505"), "allow")))) && (stryMutAct_9fa48("3507") ? validateLineage(grant, all, exactPath) !== undefined : stryMutAct_9fa48("3506") ? true : (stryCov_9fa48("3506", "3507"), validateLineage(grant, all, exactPath) === undefined)))) && (stryMutAct_9fa48("3509") ? grant.subject.kind !== "foreign" && this.guestGrantIsCurrent(grant, now) : stryMutAct_9fa48("3508") ? true : (stryCov_9fa48("3508", "3509"), (stryMutAct_9fa48("3511") ? grant.subject.kind === "foreign" : stryMutAct_9fa48("3510") ? false : (stryCov_9fa48("3510", "3511"), grant.subject.kind !== (stryMutAct_9fa48("3512") ? "" : (stryCov_9fa48("3512"), "foreign")))) || this.guestGrantIsCurrent(grant, now)))))));
      return (stryMutAct_9fa48("3513") ? allow.every(grant => grant.id.equals(backing.id)) : (stryCov_9fa48("3513"), allow.some(stryMutAct_9fa48("3514") ? () => undefined : (stryCov_9fa48("3514"), grant => grant.id.equals(backing.id))))) ? stryMutAct_9fa48("3515") ? {} : (stryCov_9fa48("3515"), {
        reason: stryMutAct_9fa48("3516") ? "" : (stryCov_9fa48("3516"), "allowed"),
        allow,
        deny: stryMutAct_9fa48("3517") ? ["Stryker was here"] : (stryCov_9fa48("3517"), [])
      }) : stryMutAct_9fa48("3518") ? {} : (stryCov_9fa48("3518"), {
        reason: stryMutAct_9fa48("3519") ? "" : (stryCov_9fa48("3519"), "noMatchingAllow"),
        allow: stryMutAct_9fa48("3520") ? ["Stryker was here"] : (stryCov_9fa48("3520"), []),
        deny: stryMutAct_9fa48("3521") ? ["Stryker was here"] : (stryCov_9fa48("3521"), [])
      });
    }
  }
  private effectiveSubjects(request: AuthorityCheckRequest): ReadonlySet<string> | undefined {
    if (stryMutAct_9fa48("3522")) {
      {}
    } else {
      stryCov_9fa48("3522");
      if (stryMutAct_9fa48("3524") ? false : stryMutAct_9fa48("3523") ? true : (stryCov_9fa48("3523", "3524"), request.principal.tenantId.equals(this.store.tenantId))) {
        if (stryMutAct_9fa48("3525")) {
          {}
        } else {
          stryCov_9fa48("3525");
          const principal = Subjects.principal(request.principal.principalId);
          const subjects = new Set(stryMutAct_9fa48("3526") ? [] : (stryCov_9fa48("3526"), [subjectKey(principal)]));
          for (const team of this.store.teams()) {
            if (stryMutAct_9fa48("3527")) {
              {}
            } else {
              stryCov_9fa48("3527");
              if (stryMutAct_9fa48("3529") ? false : stryMutAct_9fa48("3528") ? true : (stryCov_9fa48("3528", "3529"), team.has(request.principal.principalId))) {
                if (stryMutAct_9fa48("3530")) {
                  {}
                } else {
                  stryCov_9fa48("3530");
                  subjects.add(subjectKey(Subjects.team(team.id)));
                }
              }
            }
          }
          return subjects;
        }
      }
      const subject = request.binding.subject;
      return (stryMutAct_9fa48("3533") ? subject.kind === "foreign" && subject.homeTenant.equals(request.principal.tenantId) || subject.principalId.equals(request.principal.principalId) : stryMutAct_9fa48("3532") ? false : stryMutAct_9fa48("3531") ? true : (stryCov_9fa48("3531", "3532", "3533"), (stryMutAct_9fa48("3535") ? subject.kind === "foreign" || subject.homeTenant.equals(request.principal.tenantId) : stryMutAct_9fa48("3534") ? true : (stryCov_9fa48("3534", "3535"), (stryMutAct_9fa48("3537") ? subject.kind !== "foreign" : stryMutAct_9fa48("3536") ? true : (stryCov_9fa48("3536", "3537"), subject.kind === (stryMutAct_9fa48("3538") ? "" : (stryCov_9fa48("3538"), "foreign")))) && subject.homeTenant.equals(request.principal.tenantId))) && subject.principalId.equals(request.principal.principalId))) ? new Set(stryMutAct_9fa48("3539") ? [] : (stryCov_9fa48("3539"), [subjectKey(subject)])) : undefined;
    }
  }
  private currentPath(workspace: Workspace): PathEpochEvidence {
    if (stryMutAct_9fa48("3540")) {
      {}
    } else {
      stryCov_9fa48("3540");
      const epochs = workspace.scope.path.map(stryMutAct_9fa48("3541") ? () => undefined : (stryCov_9fa48("3541"), scope => this.store.epoch(scope)));
      return new PathEpochEvidence(epochs as [ScopeEpoch, ...ScopeEpoch[]]);
    }
  }
  private guestGrantIsCurrent(grant: Grant, now: Date): boolean {
    if (stryMutAct_9fa48("3542")) {
      {}
    } else {
      stryCov_9fa48("3542");
      if (stryMutAct_9fa48("3545") ? grant.subject.kind === "foreign" : stryMutAct_9fa48("3544") ? false : stryMutAct_9fa48("3543") ? true : (stryCov_9fa48("3543", "3544", "3545"), grant.subject.kind !== (stryMutAct_9fa48("3546") ? "" : (stryCov_9fa48("3546"), "foreign")))) return stryMutAct_9fa48("3547") ? false : (stryCov_9fa48("3547"), true);
      if (stryMutAct_9fa48("3550") ? grant.origin.kind !== "role" && !grant.origin.guest : stryMutAct_9fa48("3549") ? false : stryMutAct_9fa48("3548") ? true : (stryCov_9fa48("3548", "3549", "3550"), (stryMutAct_9fa48("3552") ? grant.origin.kind === "role" : stryMutAct_9fa48("3551") ? false : (stryCov_9fa48("3551", "3552"), grant.origin.kind !== (stryMutAct_9fa48("3553") ? "" : (stryCov_9fa48("3553"), "role")))) || (stryMutAct_9fa48("3554") ? grant.origin.guest : (stryCov_9fa48("3554"), !grant.origin.guest)))) return stryMutAct_9fa48("3555") ? true : (stryCov_9fa48("3555"), false);
      const membership = this.store.membership(grant.origin.membershipId);
      const verification = stryMutAct_9fa48("3556") ? membership.guestVerification : (stryCov_9fa48("3556"), membership?.guestVerification);
      if (stryMutAct_9fa48("3559") ? (membership === undefined || membership.state !== "active" || membership.subject.kind !== "foreign" || verification === undefined) && !verification.admits(membership.subject, now) : stryMutAct_9fa48("3558") ? false : stryMutAct_9fa48("3557") ? true : (stryCov_9fa48("3557", "3558", "3559"), (stryMutAct_9fa48("3561") ? (membership === undefined || membership.state !== "active" || membership.subject.kind !== "foreign") && verification === undefined : stryMutAct_9fa48("3560") ? false : (stryCov_9fa48("3560", "3561"), (stryMutAct_9fa48("3563") ? (membership === undefined || membership.state !== "active") && membership.subject.kind !== "foreign" : stryMutAct_9fa48("3562") ? false : (stryCov_9fa48("3562", "3563"), (stryMutAct_9fa48("3565") ? membership === undefined && membership.state !== "active" : stryMutAct_9fa48("3564") ? false : (stryCov_9fa48("3564", "3565"), (stryMutAct_9fa48("3567") ? membership !== undefined : stryMutAct_9fa48("3566") ? false : (stryCov_9fa48("3566", "3567"), membership === undefined)) || (stryMutAct_9fa48("3569") ? membership.state === "active" : stryMutAct_9fa48("3568") ? false : (stryCov_9fa48("3568", "3569"), membership.state !== (stryMutAct_9fa48("3570") ? "" : (stryCov_9fa48("3570"), "active")))))) || (stryMutAct_9fa48("3572") ? membership.subject.kind === "foreign" : stryMutAct_9fa48("3571") ? false : (stryCov_9fa48("3571", "3572"), membership.subject.kind !== (stryMutAct_9fa48("3573") ? "" : (stryCov_9fa48("3573"), "foreign")))))) || (stryMutAct_9fa48("3575") ? verification !== undefined : stryMutAct_9fa48("3574") ? false : (stryCov_9fa48("3574", "3575"), verification === undefined)))) || (stryMutAct_9fa48("3576") ? verification.admits(membership.subject, now) : (stryCov_9fa48("3576"), !verification.admits(membership.subject, now))))) return stryMutAct_9fa48("3577") ? true : (stryCov_9fa48("3577"), false);
      const trust = this.store.guestTrust(verification.trustId);
      return stryMutAct_9fa48("3580") ? trust?.isActive === true && trust.revision.value === verification.trustRevision.value && trust.homeTenant.equals(membership.subject.homeTenant) || trust.verifier.kind === verification.method : stryMutAct_9fa48("3579") ? false : stryMutAct_9fa48("3578") ? true : (stryCov_9fa48("3578", "3579", "3580"), (stryMutAct_9fa48("3582") ? trust?.isActive === true && trust.revision.value === verification.trustRevision.value || trust.homeTenant.equals(membership.subject.homeTenant) : stryMutAct_9fa48("3581") ? true : (stryCov_9fa48("3581", "3582"), (stryMutAct_9fa48("3584") ? trust?.isActive === true || trust.revision.value === verification.trustRevision.value : stryMutAct_9fa48("3583") ? true : (stryCov_9fa48("3583", "3584"), (stryMutAct_9fa48("3586") ? trust?.isActive !== true : stryMutAct_9fa48("3585") ? true : (stryCov_9fa48("3585", "3586"), (stryMutAct_9fa48("3587") ? trust.isActive : (stryCov_9fa48("3587"), trust?.isActive)) === (stryMutAct_9fa48("3588") ? false : (stryCov_9fa48("3588"), true)))) && (stryMutAct_9fa48("3590") ? trust.revision.value !== verification.trustRevision.value : stryMutAct_9fa48("3589") ? true : (stryCov_9fa48("3589", "3590"), trust.revision.value === verification.trustRevision.value)))) && trust.homeTenant.equals(membership.subject.homeTenant))) && (stryMutAct_9fa48("3592") ? trust.verifier.kind !== verification.method : stryMutAct_9fa48("3591") ? true : (stryCov_9fa48("3591", "3592"), trust.verifier.kind === verification.method)));
    }
  }
  private requireWorkspace(scope: ScopeRef): Workspace {
    if (stryMutAct_9fa48("3593")) {
      {}
    } else {
      stryCov_9fa48("3593");
      if (stryMutAct_9fa48("3596") ? scope.kind !== "workspace" && scope.workspaceId === undefined : stryMutAct_9fa48("3595") ? false : stryMutAct_9fa48("3594") ? true : (stryCov_9fa48("3594", "3595", "3596"), (stryMutAct_9fa48("3598") ? scope.kind === "workspace" : stryMutAct_9fa48("3597") ? false : (stryCov_9fa48("3597", "3598"), scope.kind !== (stryMutAct_9fa48("3599") ? "" : (stryCov_9fa48("3599"), "workspace")))) || (stryMutAct_9fa48("3601") ? scope.workspaceId !== undefined : stryMutAct_9fa48("3600") ? false : (stryCov_9fa48("3600", "3601"), scope.workspaceId === undefined)))) {
        if (stryMutAct_9fa48("3602")) {
          {}
        } else {
          stryCov_9fa48("3602");
          throw authorityDenied(stryMutAct_9fa48("3603") ? "" : (stryCov_9fa48("3603"), "Authority target must be a Workspace Scope"));
        }
      }
      const workspace = this.store.workspace(scope.workspaceId);
      if (stryMutAct_9fa48("3606") ? workspace === undefined && !workspace.scope.equals(scope) : stryMutAct_9fa48("3605") ? false : stryMutAct_9fa48("3604") ? true : (stryCov_9fa48("3604", "3605", "3606"), (stryMutAct_9fa48("3608") ? workspace !== undefined : stryMutAct_9fa48("3607") ? false : (stryCov_9fa48("3607", "3608"), workspace === undefined)) || (stryMutAct_9fa48("3609") ? workspace.scope.equals(scope) : (stryCov_9fa48("3609"), !workspace.scope.equals(scope))))) {
        if (stryMutAct_9fa48("3610")) {
          {}
        } else {
          stryCov_9fa48("3610");
          throw authorityDenied(stryMutAct_9fa48("3611") ? "" : (stryCov_9fa48("3611"), "Authority target does not match canonical Tenant topology"));
        }
      }
      return workspace;
    }
  }
  private requireTenant(tenantId: TenantId): void {
    if (stryMutAct_9fa48("3612")) {
      {}
    } else {
      stryCov_9fa48("3612");
      if (stryMutAct_9fa48("3615") ? false : stryMutAct_9fa48("3614") ? true : stryMutAct_9fa48("3613") ? tenantId.equals(this.store.tenantId) : (stryCov_9fa48("3613", "3614", "3615"), !tenantId.equals(this.store.tenantId))) {
        if (stryMutAct_9fa48("3616")) {
          {}
        } else {
          stryCov_9fa48("3616");
          throw authorityDenied(stryMutAct_9fa48("3617") ? "" : (stryCov_9fa48("3617"), "Authority request targets another Tenant"));
        }
      }
    }
  }
}
function validateLineage(grant: Grant, grants: readonly Grant[], exactPath: readonly ScopeRef[]): "revokedGrant" | "invalidDelegation" | undefined {
  if (stryMutAct_9fa48("3618")) {
    {}
  } else {
    stryCov_9fa48("3618");
    const byId = new Map(grants.map(stryMutAct_9fa48("3619") ? () => undefined : (stryCov_9fa48("3619"), candidate => stryMutAct_9fa48("3620") ? [] : (stryCov_9fa48("3620"), [candidate.id.value, candidate]))));
    const path = new Map(exactPath.map(stryMutAct_9fa48("3621") ? () => undefined : (stryCov_9fa48("3621"), (scope, index) => stryMutAct_9fa48("3622") ? [] : (stryCov_9fa48("3622"), [scopeKey(scope), index]))));
    const seen = new Set<string>();
    let child = grant;
    while (stryMutAct_9fa48("3624") ? false : stryMutAct_9fa48("3623") ? false : (stryCov_9fa48("3623", "3624"), true)) {
      if (stryMutAct_9fa48("3625")) {
        {}
      } else {
        stryCov_9fa48("3625");
        if (stryMutAct_9fa48("3628") ? false : stryMutAct_9fa48("3627") ? true : stryMutAct_9fa48("3626") ? child.isLive : (stryCov_9fa48("3626", "3627", "3628"), !child.isLive)) return stryMutAct_9fa48("3629") ? "" : (stryCov_9fa48("3629"), "revokedGrant");
        if (stryMutAct_9fa48("3631") ? false : stryMutAct_9fa48("3630") ? true : (stryCov_9fa48("3630", "3631"), seen.has(child.id.value))) return stryMutAct_9fa48("3632") ? "" : (stryCov_9fa48("3632"), "invalidDelegation");
        seen.add(child.id.value);
        if (stryMutAct_9fa48("3635") ? child.attenuationOf !== undefined : stryMutAct_9fa48("3634") ? false : stryMutAct_9fa48("3633") ? true : (stryCov_9fa48("3633", "3634", "3635"), child.attenuationOf === undefined)) return undefined;
        const parent = byId.get(child.attenuationOf.value);
        if (stryMutAct_9fa48("3638") ? parent === undefined && !parent.isLive : stryMutAct_9fa48("3637") ? false : stryMutAct_9fa48("3636") ? true : (stryCov_9fa48("3636", "3637", "3638"), (stryMutAct_9fa48("3640") ? parent !== undefined : stryMutAct_9fa48("3639") ? false : (stryCov_9fa48("3639", "3640"), parent === undefined)) || (stryMutAct_9fa48("3641") ? parent.isLive : (stryCov_9fa48("3641"), !parent.isLive)))) return stryMutAct_9fa48("3642") ? "" : (stryCov_9fa48("3642"), "revokedGrant");
        const parentIndex = path.get(scopeKey(parent.scope));
        const childIndex = path.get(scopeKey(child.scope));
        if (stryMutAct_9fa48("3645") ? (parent.effect !== "allow" || parentIndex === undefined || childIndex === undefined || parentIndex > childIndex) && !parent.capability.covers(child.capability) : stryMutAct_9fa48("3644") ? false : stryMutAct_9fa48("3643") ? true : (stryCov_9fa48("3643", "3644", "3645"), (stryMutAct_9fa48("3647") ? (parent.effect !== "allow" || parentIndex === undefined || childIndex === undefined) && parentIndex > childIndex : stryMutAct_9fa48("3646") ? false : (stryCov_9fa48("3646", "3647"), (stryMutAct_9fa48("3649") ? (parent.effect !== "allow" || parentIndex === undefined) && childIndex === undefined : stryMutAct_9fa48("3648") ? false : (stryCov_9fa48("3648", "3649"), (stryMutAct_9fa48("3651") ? parent.effect !== "allow" && parentIndex === undefined : stryMutAct_9fa48("3650") ? false : (stryCov_9fa48("3650", "3651"), (stryMutAct_9fa48("3653") ? parent.effect === "allow" : stryMutAct_9fa48("3652") ? false : (stryCov_9fa48("3652", "3653"), parent.effect !== (stryMutAct_9fa48("3654") ? "" : (stryCov_9fa48("3654"), "allow")))) || (stryMutAct_9fa48("3656") ? parentIndex !== undefined : stryMutAct_9fa48("3655") ? false : (stryCov_9fa48("3655", "3656"), parentIndex === undefined)))) || (stryMutAct_9fa48("3658") ? childIndex !== undefined : stryMutAct_9fa48("3657") ? false : (stryCov_9fa48("3657", "3658"), childIndex === undefined)))) || (stryMutAct_9fa48("3661") ? parentIndex <= childIndex : stryMutAct_9fa48("3660") ? parentIndex >= childIndex : stryMutAct_9fa48("3659") ? false : (stryCov_9fa48("3659", "3660", "3661"), parentIndex > childIndex)))) || (stryMutAct_9fa48("3662") ? parent.capability.covers(child.capability) : (stryCov_9fa48("3662"), !parent.capability.covers(child.capability))))) {
          if (stryMutAct_9fa48("3663")) {
            {}
          } else {
            stryCov_9fa48("3663");
            return stryMutAct_9fa48("3664") ? "" : (stryCov_9fa48("3664"), "invalidDelegation");
          }
        }
        child = parent;
      }
    }
  }
}
function scopeReaches(grantScope: ScopeRef, target: ScopeRef): boolean {
  if (stryMutAct_9fa48("3665")) {
    {}
  } else {
    stryCov_9fa48("3665");
    return stryMutAct_9fa48("3666") ? target.path.every(scope => scope.equals(grantScope)) : (stryCov_9fa48("3666"), target.path.some(stryMutAct_9fa48("3667") ? () => undefined : (stryCov_9fa48("3667"), scope => scope.equals(grantScope))));
  }
}
function authorityDenied(message: string): AgentCoreError {
  if (stryMutAct_9fa48("3668")) {
    {}
  } else {
    stryCov_9fa48("3668");
    return new AgentCoreError(stryMutAct_9fa48("3669") ? "" : (stryCov_9fa48("3669"), "authority.denied"), message);
  }
}