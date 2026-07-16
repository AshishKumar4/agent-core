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
import { ActorId } from "../actors";
import { Digest, Revision, encodeBase64, encodeCanonicalJson } from "../core";
import { AgentCoreError } from "../errors";
import { Membership, MembershipId, GuestTrust, GuestTrustId, GuestVerification, BUILT_IN_ROLES, OWNER_ROLE, Principal, PrincipalId, Project, ProjectId, Role, RoleName, ScopeRef, SubjectRef, Team, TeamId, Tenant, TenantId, WorkspaceId, Workspace, type GuestTrustVerifier, type MembershipState, type TenantKind } from "../identity";
import { ScopeEpoch } from "./epoch";
import { Grant } from "./grant";
import { GrantId } from "./id";
import { RoleGrantMaterializer } from "./materializer";
import { EpochPlanner, type ResolverInputMutation } from "./planner";
import { scopeKey, subjectKey } from "./reference";
export interface TenantControlBootstrapAnchor {
  readonly actorId: ActorId;
  readonly tenantId: TenantId;
  readonly principalId: PrincipalId;
  readonly trustAnchor: Uint8Array;
  readonly tenantKind?: TenantKind;
}
export interface TenantControlBootstrapPlan {
  readonly tenant: Tenant;
  readonly owner: Principal;
  readonly ownerMembership: Membership;
  readonly roles: typeof BUILT_IN_ROLES;
  readonly grants: readonly Grant[];
  readonly epochs: readonly ScopeEpoch[];
}
export function createTenantControlBootstrapPlan(anchor: TenantControlBootstrapAnchor, expectedRevision: Revision): TenantControlBootstrapPlan {
  if (stryMutAct_9fa48("3670")) {
    {}
  } else {
    stryCov_9fa48("3670");
    if (stryMutAct_9fa48("3673") ? expectedRevision.value === Revision.initial().value : stryMutAct_9fa48("3672") ? false : stryMutAct_9fa48("3671") ? true : (stryCov_9fa48("3671", "3672", "3673"), expectedRevision.value !== Revision.initial().value)) {
      if (stryMutAct_9fa48("3674")) {
        {}
      } else {
        stryCov_9fa48("3674");
        throw new AgentCoreError(stryMutAct_9fa48("3675") ? "" : (stryCov_9fa48("3675"), "protocol.revision-conflict"), stryMutAct_9fa48("3676") ? "" : (stryCov_9fa48("3676"), "Tenant bootstrap requires the initial authorization revision"));
      }
    }
    if (stryMutAct_9fa48("3679") ? (!(anchor.actorId instanceof ActorId) || !(anchor.trustAnchor instanceof Uint8Array)) && anchor.trustAnchor.byteLength === 0 : stryMutAct_9fa48("3678") ? false : stryMutAct_9fa48("3677") ? true : (stryCov_9fa48("3677", "3678", "3679"), (stryMutAct_9fa48("3681") ? !(anchor.actorId instanceof ActorId) && !(anchor.trustAnchor instanceof Uint8Array) : stryMutAct_9fa48("3680") ? false : (stryCov_9fa48("3680", "3681"), (stryMutAct_9fa48("3682") ? anchor.actorId instanceof ActorId : (stryCov_9fa48("3682"), !(anchor.actorId instanceof ActorId))) || (stryMutAct_9fa48("3683") ? anchor.trustAnchor instanceof Uint8Array : (stryCov_9fa48("3683"), !(anchor.trustAnchor instanceof Uint8Array))))) || (stryMutAct_9fa48("3685") ? anchor.trustAnchor.byteLength !== 0 : stryMutAct_9fa48("3684") ? false : (stryCov_9fa48("3684", "3685"), anchor.trustAnchor.byteLength === 0)))) {
      if (stryMutAct_9fa48("3686")) {
        {}
      } else {
        stryCov_9fa48("3686");
        throw new AgentCoreError(stryMutAct_9fa48("3687") ? "" : (stryCov_9fa48("3687"), "protocol.invalid-state"), stryMutAct_9fa48("3688") ? "" : (stryCov_9fa48("3688"), "Tenant bootstrap anchor is malformed"));
      }
    }
    const tenantScope = ScopeRef.tenant(anchor.tenantId);
    const owner = new Principal(anchor.principalId, stryMutAct_9fa48("3689") ? "" : (stryCov_9fa48("3689"), "user"), stryMutAct_9fa48("3690") ? "" : (stryCov_9fa48("3690"), "active"));
    const tenant = new Tenant(anchor.tenantId, stryMutAct_9fa48("3691") ? anchor.tenantKind && "personal" : (stryCov_9fa48("3691"), anchor.tenantKind ?? (stryMutAct_9fa48("3692") ? "" : (stryCov_9fa48("3692"), "personal"))), stryMutAct_9fa48("3693") ? "" : (stryCov_9fa48("3693"), "active"), expectedRevision);
    const ownerMembership = new Membership(deterministicOwnerMembershipId(anchor), tenantScope, SubjectRef.principal(anchor.principalId), OWNER_ROLE.name, stryMutAct_9fa48("3694") ? "" : (stryCov_9fa48("3694"), "active"), Revision.initial());
    const materialization = new RoleGrantMaterializer().materialize(stryMutAct_9fa48("3695") ? {} : (stryCov_9fa48("3695"), {
      membership: ownerMembership,
      role: OWNER_ROLE,
      existing: stryMutAct_9fa48("3696") ? ["Stryker was here"] : (stryCov_9fa48("3696"), [])
    }));
    const epochPlan = new EpochPlanner().plan(stryMutAct_9fa48("3697") ? ["Stryker was here"] : (stryCov_9fa48("3697"), []), stryMutAct_9fa48("3698") ? [] : (stryCov_9fa48("3698"), [stryMutAct_9fa48("3699") ? {} : (stryCov_9fa48("3699"), {
      kind: stryMutAct_9fa48("3700") ? "" : (stryCov_9fa48("3700"), "membership"),
      affectedScopes: stryMutAct_9fa48("3701") ? [] : (stryCov_9fa48("3701"), [tenantScope])
    })]));
    return Object.freeze(stryMutAct_9fa48("3702") ? {} : (stryCov_9fa48("3702"), {
      tenant,
      owner,
      ownerMembership,
      roles: BUILT_IN_ROLES,
      grants: materialization.desiredRecords,
      epochs: epochPlan.bumped
    }));
  }
}
export interface AuthorityMutationStore {
  readonly tenantId: TenantId;
  transaction<Result>(operation: (store: AuthorityMutationStore) => Result): Result;
  principal(id: PrincipalId): Principal | undefined;
  putPrincipal(principal: Principal): void;
  team(id: TeamId): Team | undefined;
  teams(): readonly Team[];
  putTeam(team: Team): void;
  project(id: ProjectId): Project | undefined;
  putProject(project: Project): void;
  workspace(id: WorkspaceId): Workspace | undefined;
  putWorkspace(workspace: Workspace): void;
  guestTrust(id: GuestTrustId): GuestTrust | undefined;
  guestTrusts(): readonly GuestTrust[];
  putGuestTrust(trust: GuestTrust): void;
  role(name: RoleName): Role | undefined;
  putRole(role: Role): void;
  membership(id: MembershipId): Membership | undefined;
  memberships(): readonly Membership[];
  putMembership(membership: Membership): void;
  grant(id: GrantId): Grant | undefined;
  grants(): readonly Grant[];
  putGrant(grant: Grant): void;
  epochs(): readonly ScopeEpoch[];
  epoch(scope: ScopeEpoch["scope"]): ScopeEpoch;
  putEpoch(epoch: ScopeEpoch): void;
}
export interface MembershipChangeIntent {
  readonly role: RoleName;
  readonly state: Exclude<MembershipState, "revoked">;
}

/** @internal Couples all post-bootstrap resolver-input writes in one Tenant transaction. */
export class AuthorityMutationService {
  readonly #materializer = new RoleGrantMaterializer();
  readonly #planner = new EpochPlanner();
  public constructor(private readonly store: AuthorityMutationStore) {}
  public createPrincipal(principal: Principal): Principal {
    if (stryMutAct_9fa48("3703")) {
      {}
    } else {
      stryCov_9fa48("3703");
      return this.store.transaction(store => {
        if (stryMutAct_9fa48("3704")) {
          {}
        } else {
          stryCov_9fa48("3704");
          requireAbsent(store.principal(principal.id), stryMutAct_9fa48("3705") ? "" : (stryCov_9fa48("3705"), "Principal"));
          store.putPrincipal(principal);
          return principal;
        }
      });
    }
  }
  public disablePrincipal(id: PrincipalId): Principal {
    if (stryMutAct_9fa48("3706")) {
      {}
    } else {
      stryCov_9fa48("3706");
      return this.store.transaction(store => {
        if (stryMutAct_9fa48("3707")) {
          {}
        } else {
          stryCov_9fa48("3707");
          const principal = requireRecord(store.principal(id), stryMutAct_9fa48("3708") ? "" : (stryCov_9fa48("3708"), "Principal"));
          const disabled = principal.disable();
          if (stryMutAct_9fa48("3711") ? disabled !== principal : stryMutAct_9fa48("3710") ? false : stryMutAct_9fa48("3709") ? true : (stryCov_9fa48("3709", "3710", "3711"), disabled === principal)) return principal;
          store.putPrincipal(disabled);
          this.bump(store, closureMutation(stryMutAct_9fa48("3712") ? "" : (stryCov_9fa48("3712"), "principalClosure"), principalScopes(store, id)));
          return disabled;
        }
      });
    }
  }
  public createTeam(team: Team): Team {
    if (stryMutAct_9fa48("3713")) {
      {}
    } else {
      stryCov_9fa48("3713");
      return this.store.transaction(store => {
        if (stryMutAct_9fa48("3714")) {
          {}
        } else {
          stryCov_9fa48("3714");
          requireAbsent(store.team(team.id), stryMutAct_9fa48("3715") ? "" : (stryCov_9fa48("3715"), "Team"));
          if (stryMutAct_9fa48("3718") ? false : stryMutAct_9fa48("3717") ? true : stryMutAct_9fa48("3716") ? team.tenantId.equals(store.tenantId) : (stryCov_9fa48("3716", "3717", "3718"), !team.tenantId.equals(store.tenantId))) {
            if (stryMutAct_9fa48("3719")) {
              {}
            } else {
              stryCov_9fa48("3719");
              throw new AgentCoreError(stryMutAct_9fa48("3720") ? "" : (stryCov_9fa48("3720"), "protocol.invalid-state"), stryMutAct_9fa48("3721") ? "" : (stryCov_9fa48("3721"), "Team belongs to another Tenant"));
            }
          }
          if (stryMutAct_9fa48("3724") ? team.revision.value === Revision.initial().value : stryMutAct_9fa48("3723") ? false : stryMutAct_9fa48("3722") ? true : (stryCov_9fa48("3722", "3723", "3724"), team.revision.value !== Revision.initial().value)) {
            if (stryMutAct_9fa48("3725")) {
              {}
            } else {
              stryCov_9fa48("3725");
              throw new AgentCoreError(stryMutAct_9fa48("3726") ? "" : (stryCov_9fa48("3726"), "protocol.invalid-state"), stryMutAct_9fa48("3727") ? "" : (stryCov_9fa48("3727"), "New Teams require revision zero"));
            }
          }
          requirePrincipals(store, team.principals);
          store.putTeam(team);
          return team;
        }
      });
    }
  }
  public changeTeam(id: TeamId, name: string, principals: readonly PrincipalId[]): Team {
    if (stryMutAct_9fa48("3728")) {
      {}
    } else {
      stryCov_9fa48("3728");
      return this.store.transaction(store => {
        if (stryMutAct_9fa48("3729")) {
          {}
        } else {
          stryCov_9fa48("3729");
          const current = requireRecord(store.team(id), stryMutAct_9fa48("3730") ? "" : (stryCov_9fa48("3730"), "Team"));
          requirePrincipals(store, principals);
          const changed = current.revise(name, principals);
          store.putTeam(changed);
          this.bump(store, closureMutation(stryMutAct_9fa48("3731") ? "" : (stryCov_9fa48("3731"), "teamClosure"), teamScopes(store, id)));
          return changed;
        }
      });
    }
  }
  public createWorkspace(workspace: Workspace): Workspace {
    if (stryMutAct_9fa48("3732")) {
      {}
    } else {
      stryCov_9fa48("3732");
      return this.store.transaction(store => {
        if (stryMutAct_9fa48("3733")) {
          {}
        } else {
          stryCov_9fa48("3733");
          requireAbsent(store.workspace(workspace.id), stryMutAct_9fa48("3734") ? "" : (stryCov_9fa48("3734"), "Workspace"));
          if (stryMutAct_9fa48("3737") ? !workspace.tenantId.equals(store.tenantId) && workspace.revision.value !== 0 : stryMutAct_9fa48("3736") ? false : stryMutAct_9fa48("3735") ? true : (stryCov_9fa48("3735", "3736", "3737"), (stryMutAct_9fa48("3738") ? workspace.tenantId.equals(store.tenantId) : (stryCov_9fa48("3738"), !workspace.tenantId.equals(store.tenantId))) || (stryMutAct_9fa48("3740") ? workspace.revision.value === 0 : stryMutAct_9fa48("3739") ? false : (stryCov_9fa48("3739", "3740"), workspace.revision.value !== 0)))) {
            if (stryMutAct_9fa48("3741")) {
              {}
            } else {
              stryCov_9fa48("3741");
              throw new AgentCoreError(stryMutAct_9fa48("3742") ? "" : (stryCov_9fa48("3742"), "protocol.invalid-state"), stryMutAct_9fa48("3743") ? "" : (stryCov_9fa48("3743"), "New Workspaces require the local Tenant and revision zero"));
            }
          }
          if (stryMutAct_9fa48("3746") ? workspace.projectId === undefined : stryMutAct_9fa48("3745") ? false : stryMutAct_9fa48("3744") ? true : (stryCov_9fa48("3744", "3745", "3746"), workspace.projectId !== undefined)) {
            if (stryMutAct_9fa48("3747")) {
              {}
            } else {
              stryCov_9fa48("3747");
              requireRecord(store.project(workspace.projectId), stryMutAct_9fa48("3748") ? "" : (stryCov_9fa48("3748"), "Workspace Project"));
            }
          }
          store.putWorkspace(workspace);
          this.bump(store, stryMutAct_9fa48("3749") ? [] : (stryCov_9fa48("3749"), [stryMutAct_9fa48("3750") ? {} : (stryCov_9fa48("3750"), {
            kind: stryMutAct_9fa48("3751") ? "" : (stryCov_9fa48("3751"), "topology"),
            affectedScopes: stryMutAct_9fa48("3752") ? [] : (stryCov_9fa48("3752"), [workspace.scope])
          })]));
          return workspace;
        }
      });
    }
  }
  public createProject(project: Project): Project {
    if (stryMutAct_9fa48("3753")) {
      {}
    } else {
      stryCov_9fa48("3753");
      return this.store.transaction(store => {
        if (stryMutAct_9fa48("3754")) {
          {}
        } else {
          stryCov_9fa48("3754");
          requireAbsent(store.project(project.id), stryMutAct_9fa48("3755") ? "" : (stryCov_9fa48("3755"), "Project"));
          if (stryMutAct_9fa48("3758") ? !project.tenantId.equals(store.tenantId) && project.revision.value !== 0 : stryMutAct_9fa48("3757") ? false : stryMutAct_9fa48("3756") ? true : (stryCov_9fa48("3756", "3757", "3758"), (stryMutAct_9fa48("3759") ? project.tenantId.equals(store.tenantId) : (stryCov_9fa48("3759"), !project.tenantId.equals(store.tenantId))) || (stryMutAct_9fa48("3761") ? project.revision.value === 0 : stryMutAct_9fa48("3760") ? false : (stryCov_9fa48("3760", "3761"), project.revision.value !== 0)))) {
            if (stryMutAct_9fa48("3762")) {
              {}
            } else {
              stryCov_9fa48("3762");
              throw new AgentCoreError(stryMutAct_9fa48("3763") ? "" : (stryCov_9fa48("3763"), "protocol.invalid-state"), stryMutAct_9fa48("3764") ? "" : (stryCov_9fa48("3764"), "New Projects require the local Tenant and revision zero"));
            }
          }
          store.putProject(project);
          return project;
        }
      });
    }
  }
  public renameProject(id: ProjectId, name: string): Project {
    if (stryMutAct_9fa48("3765")) {
      {}
    } else {
      stryCov_9fa48("3765");
      return this.store.transaction(store => {
        if (stryMutAct_9fa48("3766")) {
          {}
        } else {
          stryCov_9fa48("3766");
          const project = requireRecord(store.project(id), stryMutAct_9fa48("3767") ? "" : (stryCov_9fa48("3767"), "Project")).rename(name);
          store.putProject(project);
          return project;
        }
      });
    }
  }
  public createGuestTrust(trust: GuestTrust): GuestTrust {
    if (stryMutAct_9fa48("3768")) {
      {}
    } else {
      stryCov_9fa48("3768");
      return this.store.transaction(store => {
        if (stryMutAct_9fa48("3769")) {
          {}
        } else {
          stryCov_9fa48("3769");
          requireAbsent(store.guestTrust(trust.id), stryMutAct_9fa48("3770") ? "" : (stryCov_9fa48("3770"), "Guest trust"));
          if (stryMutAct_9fa48("3773") ? (!trust.hostTenant.equals(store.tenantId) || !trust.isActive) && trust.revision.value !== 0 : stryMutAct_9fa48("3772") ? false : stryMutAct_9fa48("3771") ? true : (stryCov_9fa48("3771", "3772", "3773"), (stryMutAct_9fa48("3775") ? !trust.hostTenant.equals(store.tenantId) && !trust.isActive : stryMutAct_9fa48("3774") ? false : (stryCov_9fa48("3774", "3775"), (stryMutAct_9fa48("3776") ? trust.hostTenant.equals(store.tenantId) : (stryCov_9fa48("3776"), !trust.hostTenant.equals(store.tenantId))) || (stryMutAct_9fa48("3777") ? trust.isActive : (stryCov_9fa48("3777"), !trust.isActive)))) || (stryMutAct_9fa48("3779") ? trust.revision.value === 0 : stryMutAct_9fa48("3778") ? false : (stryCov_9fa48("3778", "3779"), trust.revision.value !== 0)))) {
            if (stryMutAct_9fa48("3780")) {
              {}
            } else {
              stryCov_9fa48("3780");
              throw new AgentCoreError(stryMutAct_9fa48("3781") ? "" : (stryCov_9fa48("3781"), "protocol.invalid-state"), stryMutAct_9fa48("3782") ? "" : (stryCov_9fa48("3782"), "New guest trust requires the local host Tenant, active state, and revision zero"));
            }
          }
          store.putGuestTrust(trust);
          return trust;
        }
      });
    }
  }
  public rotateGuestTrust(id: GuestTrustId, verifier: GuestTrustVerifier): GuestTrust {
    if (stryMutAct_9fa48("3783")) {
      {}
    } else {
      stryCov_9fa48("3783");
      return this.store.transaction(store => {
        if (stryMutAct_9fa48("3784")) {
          {}
        } else {
          stryCov_9fa48("3784");
          const trust = requireRecord(store.guestTrust(id), stryMutAct_9fa48("3785") ? "" : (stryCov_9fa48("3785"), "Guest trust"));
          const rotated = trust.rotate(verifier);
          store.putGuestTrust(rotated);
          this.revokeGuestMemberships(store, trust);
          return rotated;
        }
      });
    }
  }
  public revokeGuestTrust(id: GuestTrustId): GuestTrust {
    if (stryMutAct_9fa48("3786")) {
      {}
    } else {
      stryCov_9fa48("3786");
      return this.store.transaction(store => {
        if (stryMutAct_9fa48("3787")) {
          {}
        } else {
          stryCov_9fa48("3787");
          const trust = requireRecord(store.guestTrust(id), stryMutAct_9fa48("3788") ? "" : (stryCov_9fa48("3788"), "Guest trust"));
          const revoked = trust.revoke();
          if (stryMutAct_9fa48("3791") ? revoked !== trust : stryMutAct_9fa48("3790") ? false : stryMutAct_9fa48("3789") ? true : (stryCov_9fa48("3789", "3790", "3791"), revoked === trust)) return trust;
          store.putGuestTrust(revoked);
          this.revokeGuestMemberships(store, trust);
          return revoked;
        }
      });
    }
  }
  public createRole(role: Role): Role {
    if (stryMutAct_9fa48("3792")) {
      {}
    } else {
      stryCov_9fa48("3792");
      return this.store.transaction(store => {
        if (stryMutAct_9fa48("3793")) {
          {}
        } else {
          stryCov_9fa48("3793");
          requireAbsent(store.role(role.name), stryMutAct_9fa48("3794") ? "" : (stryCov_9fa48("3794"), "Role"));
          store.putRole(role);
          return role;
        }
      });
    }
  }
  public changeRole(role: Role): Role {
    if (stryMutAct_9fa48("3795")) {
      {}
    } else {
      stryCov_9fa48("3795");
      return this.store.transaction(store => {
        if (stryMutAct_9fa48("3796")) {
          {}
        } else {
          stryCov_9fa48("3796");
          const current = requireRecord(store.role(role.name), stryMutAct_9fa48("3797") ? "" : (stryCov_9fa48("3797"), "Role"));
          if (stryMutAct_9fa48("3799") ? false : stryMutAct_9fa48("3798") ? true : (stryCov_9fa48("3798", "3799"), equalBytes(Role.encode(current), Role.encode(role)))) return current;
          store.putRole(role);
          const affected = new Map<string, ScopeEpoch["scope"]>();
          for (const membership of stryMutAct_9fa48("3800") ? store.memberships() : (stryCov_9fa48("3800"), store.memberships().filter(stryMutAct_9fa48("3801") ? () => undefined : (stryCov_9fa48("3801"), entry => entry.role.equals(role.name))))) {
            if (stryMutAct_9fa48("3802")) {
              {}
            } else {
              stryCov_9fa48("3802");
              for (const scope of this.reconcile(store, membership, role)) {
                if (stryMutAct_9fa48("3803")) {
                  {}
                } else {
                  stryCov_9fa48("3803");
                  affected.set(scopeKey(scope), scope);
                }
              }
            }
          }
          this.bump(store, closureMutation(stryMutAct_9fa48("3804") ? "" : (stryCov_9fa48("3804"), "role"), stryMutAct_9fa48("3805") ? [] : (stryCov_9fa48("3805"), [...affected.values()])));
          return role;
        }
      });
    }
  }
  public assignMembership(membership: Membership): Membership {
    if (stryMutAct_9fa48("3806")) {
      {}
    } else {
      stryCov_9fa48("3806");
      return this.store.transaction(store => {
        if (stryMutAct_9fa48("3807")) {
          {}
        } else {
          stryCov_9fa48("3807");
          requireAbsent(store.membership(membership.id), stryMutAct_9fa48("3808") ? "" : (stryCov_9fa48("3808"), "Membership"));
          if (stryMutAct_9fa48("3811") ? membership.revision.value !== 0 && membership.state !== "active" : stryMutAct_9fa48("3810") ? false : stryMutAct_9fa48("3809") ? true : (stryCov_9fa48("3809", "3810", "3811"), (stryMutAct_9fa48("3813") ? membership.revision.value === 0 : stryMutAct_9fa48("3812") ? false : (stryCov_9fa48("3812", "3813"), membership.revision.value !== 0)) || (stryMutAct_9fa48("3815") ? membership.state === "active" : stryMutAct_9fa48("3814") ? false : (stryCov_9fa48("3814", "3815"), membership.state !== (stryMutAct_9fa48("3816") ? "" : (stryCov_9fa48("3816"), "active")))))) {
            if (stryMutAct_9fa48("3817")) {
              {}
            } else {
              stryCov_9fa48("3817");
              throw new AgentCoreError(stryMutAct_9fa48("3818") ? "" : (stryCov_9fa48("3818"), "protocol.invalid-state"), stryMutAct_9fa48("3819") ? "" : (stryCov_9fa48("3819"), "New Memberships must be active at revision zero"));
            }
          }
          const role = requireRecord(store.role(membership.role), stryMutAct_9fa48("3820") ? "" : (stryCov_9fa48("3820"), "Role"));
          requireCanonicalScope(store, membership.scope);
          requireMembershipSubject(store, membership);
          if (stryMutAct_9fa48("3823") ? membership.subject.kind !== "foreign" : stryMutAct_9fa48("3822") ? false : stryMutAct_9fa48("3821") ? true : (stryCov_9fa48("3821", "3822", "3823"), membership.subject.kind === (stryMutAct_9fa48("3824") ? "" : (stryCov_9fa48("3824"), "foreign")))) {
            if (stryMutAct_9fa48("3825")) {
              {}
            } else {
              stryCov_9fa48("3825");
              throw new AgentCoreError(stryMutAct_9fa48("3826") ? "" : (stryCov_9fa48("3826"), "authority.denied"), stryMutAct_9fa48("3827") ? "" : (stryCov_9fa48("3827"), "Guest Memberships require verified provenance"));
            }
          }
          const affected = this.reconcile(store, membership, role);
          store.putMembership(membership);
          this.bump(store, stryMutAct_9fa48("3828") ? [] : (stryCov_9fa48("3828"), [stryMutAct_9fa48("3829") ? {} : (stryCov_9fa48("3829"), {
            kind: stryMutAct_9fa48("3830") ? "" : (stryCov_9fa48("3830"), "membership"),
            affectedScopes: nonEmpty(stryMutAct_9fa48("3831") ? [] : (stryCov_9fa48("3831"), [membership.scope, ...affected]))
          })]));
          return membership;
        }
      });
    }
  }
  public assignGuestMembership(membership: Membership, verification: GuestVerification, now: Date): Membership {
    if (stryMutAct_9fa48("3832")) {
      {}
    } else {
      stryCov_9fa48("3832");
      if (stryMutAct_9fa48("3835") ? false : stryMutAct_9fa48("3834") ? true : stryMutAct_9fa48("3833") ? verification.isHostMinted : (stryCov_9fa48("3833", "3834", "3835"), !verification.isHostMinted)) {
        if (stryMutAct_9fa48("3836")) {
          {}
        } else {
          stryCov_9fa48("3836");
          throw new AgentCoreError(stryMutAct_9fa48("3837") ? "" : (stryCov_9fa48("3837"), "authority.denied"), stryMutAct_9fa48("3838") ? "" : (stryCov_9fa48("3838"), "Guest verification was not host minted"));
        }
      }
      return this.store.transaction(store => {
        if (stryMutAct_9fa48("3839")) {
          {}
        } else {
          stryCov_9fa48("3839");
          requireAbsent(store.membership(membership.id), stryMutAct_9fa48("3840") ? "" : (stryCov_9fa48("3840"), "Membership"));
          if (stryMutAct_9fa48("3843") ? (membership.subject.kind !== "foreign" || membership.revision.value !== 0) && membership.state !== "active" : stryMutAct_9fa48("3842") ? false : stryMutAct_9fa48("3841") ? true : (stryCov_9fa48("3841", "3842", "3843"), (stryMutAct_9fa48("3845") ? membership.subject.kind !== "foreign" && membership.revision.value !== 0 : stryMutAct_9fa48("3844") ? false : (stryCov_9fa48("3844", "3845"), (stryMutAct_9fa48("3847") ? membership.subject.kind === "foreign" : stryMutAct_9fa48("3846") ? false : (stryCov_9fa48("3846", "3847"), membership.subject.kind !== (stryMutAct_9fa48("3848") ? "" : (stryCov_9fa48("3848"), "foreign")))) || (stryMutAct_9fa48("3850") ? membership.revision.value === 0 : stryMutAct_9fa48("3849") ? false : (stryCov_9fa48("3849", "3850"), membership.revision.value !== 0)))) || (stryMutAct_9fa48("3852") ? membership.state === "active" : stryMutAct_9fa48("3851") ? false : (stryCov_9fa48("3851", "3852"), membership.state !== (stryMutAct_9fa48("3853") ? "" : (stryCov_9fa48("3853"), "active")))))) {
            if (stryMutAct_9fa48("3854")) {
              {}
            } else {
              stryCov_9fa48("3854");
              throw new AgentCoreError(stryMutAct_9fa48("3855") ? "" : (stryCov_9fa48("3855"), "protocol.invalid-state"), stryMutAct_9fa48("3856") ? "" : (stryCov_9fa48("3856"), "New guest Memberships require a foreign active subject at revision zero"));
            }
          }
          const trust = requireRecord(store.guestTrust(verification.trustId), stryMutAct_9fa48("3857") ? "" : (stryCov_9fa48("3857"), "Guest trust"));
          if (stryMutAct_9fa48("3860") ? (!trust.isActive || !trust.hostTenant.equals(store.tenantId) || !trust.homeTenant.equals(membership.subject.homeTenant) || trust.revision.value !== verification.trustRevision.value || trust.verifier.kind !== verification.method) && !verification.admits(membership.subject, now) : stryMutAct_9fa48("3859") ? false : stryMutAct_9fa48("3858") ? true : (stryCov_9fa48("3858", "3859", "3860"), (stryMutAct_9fa48("3862") ? (!trust.isActive || !trust.hostTenant.equals(store.tenantId) || !trust.homeTenant.equals(membership.subject.homeTenant) || trust.revision.value !== verification.trustRevision.value) && trust.verifier.kind !== verification.method : stryMutAct_9fa48("3861") ? false : (stryCov_9fa48("3861", "3862"), (stryMutAct_9fa48("3864") ? (!trust.isActive || !trust.hostTenant.equals(store.tenantId) || !trust.homeTenant.equals(membership.subject.homeTenant)) && trust.revision.value !== verification.trustRevision.value : stryMutAct_9fa48("3863") ? false : (stryCov_9fa48("3863", "3864"), (stryMutAct_9fa48("3866") ? (!trust.isActive || !trust.hostTenant.equals(store.tenantId)) && !trust.homeTenant.equals(membership.subject.homeTenant) : stryMutAct_9fa48("3865") ? false : (stryCov_9fa48("3865", "3866"), (stryMutAct_9fa48("3868") ? !trust.isActive && !trust.hostTenant.equals(store.tenantId) : stryMutAct_9fa48("3867") ? false : (stryCov_9fa48("3867", "3868"), (stryMutAct_9fa48("3869") ? trust.isActive : (stryCov_9fa48("3869"), !trust.isActive)) || (stryMutAct_9fa48("3870") ? trust.hostTenant.equals(store.tenantId) : (stryCov_9fa48("3870"), !trust.hostTenant.equals(store.tenantId))))) || (stryMutAct_9fa48("3871") ? trust.homeTenant.equals(membership.subject.homeTenant) : (stryCov_9fa48("3871"), !trust.homeTenant.equals(membership.subject.homeTenant))))) || (stryMutAct_9fa48("3873") ? trust.revision.value === verification.trustRevision.value : stryMutAct_9fa48("3872") ? false : (stryCov_9fa48("3872", "3873"), trust.revision.value !== verification.trustRevision.value)))) || (stryMutAct_9fa48("3875") ? trust.verifier.kind === verification.method : stryMutAct_9fa48("3874") ? false : (stryCov_9fa48("3874", "3875"), trust.verifier.kind !== verification.method)))) || (stryMutAct_9fa48("3876") ? verification.admits(membership.subject, now) : (stryCov_9fa48("3876"), !verification.admits(membership.subject, now))))) {
            if (stryMutAct_9fa48("3877")) {
              {}
            } else {
              stryCov_9fa48("3877");
              throw new AgentCoreError(stryMutAct_9fa48("3878") ? "" : (stryCov_9fa48("3878"), "authority.denied"), stryMutAct_9fa48("3879") ? "" : (stryCov_9fa48("3879"), "Guest verification is not currently valid"));
            }
          }
          const role = requireRecord(store.role(membership.role), stryMutAct_9fa48("3880") ? "" : (stryCov_9fa48("3880"), "Role"));
          requireCanonicalScope(store, membership.scope);
          const verifiedMembership = membership.withGuestVerification(verification);
          const affected = this.reconcile(store, verifiedMembership, role);
          store.putMembership(verifiedMembership);
          this.bump(store, stryMutAct_9fa48("3881") ? [] : (stryCov_9fa48("3881"), [stryMutAct_9fa48("3882") ? {} : (stryCov_9fa48("3882"), {
            kind: stryMutAct_9fa48("3883") ? "" : (stryCov_9fa48("3883"), "membership"),
            affectedScopes: nonEmpty(stryMutAct_9fa48("3884") ? [] : (stryCov_9fa48("3884"), [membership.scope, ...affected]))
          })]));
          return verifiedMembership;
        }
      });
    }
  }
  public changeMembership(id: MembershipId, intent: MembershipChangeIntent): Membership {
    if (stryMutAct_9fa48("3885")) {
      {}
    } else {
      stryCov_9fa48("3885");
      return this.store.transaction(store => {
        if (stryMutAct_9fa48("3886")) {
          {}
        } else {
          stryCov_9fa48("3886");
          const current = requireRecord(store.membership(id), stryMutAct_9fa48("3887") ? "" : (stryCov_9fa48("3887"), "Membership"));
          const role = requireRecord(store.role(intent.role), stryMutAct_9fa48("3888") ? "" : (stryCov_9fa48("3888"), "Role"));
          const changed = current.revise(intent.role, intent.state);
          const affected = this.reconcile(store, changed, role);
          store.putMembership(changed);
          this.bump(store, stryMutAct_9fa48("3889") ? [] : (stryCov_9fa48("3889"), [stryMutAct_9fa48("3890") ? {} : (stryCov_9fa48("3890"), {
            kind: stryMutAct_9fa48("3891") ? "" : (stryCov_9fa48("3891"), "membership"),
            affectedScopes: nonEmpty(stryMutAct_9fa48("3892") ? [] : (stryCov_9fa48("3892"), [current.scope, ...affected]))
          })]));
          return changed;
        }
      });
    }
  }
  public revokeMembership(id: MembershipId): Membership {
    if (stryMutAct_9fa48("3893")) {
      {}
    } else {
      stryCov_9fa48("3893");
      return this.store.transaction(store => {
        if (stryMutAct_9fa48("3894")) {
          {}
        } else {
          stryCov_9fa48("3894");
          const current = requireRecord(store.membership(id), stryMutAct_9fa48("3895") ? "" : (stryCov_9fa48("3895"), "Membership"));
          if (stryMutAct_9fa48("3898") ? current.state !== "revoked" : stryMutAct_9fa48("3897") ? false : stryMutAct_9fa48("3896") ? true : (stryCov_9fa48("3896", "3897", "3898"), current.state === (stryMutAct_9fa48("3899") ? "" : (stryCov_9fa48("3899"), "revoked")))) return current;
          const role = requireRecord(store.role(current.role), stryMutAct_9fa48("3900") ? "" : (stryCov_9fa48("3900"), "Role"));
          const revoked = current.revoke();
          const affected = this.reconcile(store, revoked, role);
          store.putMembership(revoked);
          this.bump(store, stryMutAct_9fa48("3901") ? [] : (stryCov_9fa48("3901"), [stryMutAct_9fa48("3902") ? {} : (stryCov_9fa48("3902"), {
            kind: stryMutAct_9fa48("3903") ? "" : (stryCov_9fa48("3903"), "membership"),
            affectedScopes: nonEmpty(stryMutAct_9fa48("3904") ? [] : (stryCov_9fa48("3904"), [current.scope, ...affected]))
          })]));
          return revoked;
        }
      });
    }
  }
  public createGrant(grant: Grant): Grant {
    if (stryMutAct_9fa48("3905")) {
      {}
    } else {
      stryCov_9fa48("3905");
      return this.store.transaction(store => {
        if (stryMutAct_9fa48("3906")) {
          {}
        } else {
          stryCov_9fa48("3906");
          requireAbsent(store.grant(grant.id), stryMutAct_9fa48("3907") ? "" : (stryCov_9fa48("3907"), "Grant"));
          if (stryMutAct_9fa48("3910") ? grant.origin.kind !== "direct" && !grant.isLive : stryMutAct_9fa48("3909") ? false : stryMutAct_9fa48("3908") ? true : (stryCov_9fa48("3908", "3909", "3910"), (stryMutAct_9fa48("3912") ? grant.origin.kind === "direct" : stryMutAct_9fa48("3911") ? false : (stryCov_9fa48("3911", "3912"), grant.origin.kind !== (stryMutAct_9fa48("3913") ? "" : (stryCov_9fa48("3913"), "direct")))) || (stryMutAct_9fa48("3914") ? grant.isLive : (stryCov_9fa48("3914"), !grant.isLive)))) {
            if (stryMutAct_9fa48("3915")) {
              {}
            } else {
              stryCov_9fa48("3915");
              throw new AgentCoreError(stryMutAct_9fa48("3916") ? "" : (stryCov_9fa48("3916"), "protocol.invalid-state"), stryMutAct_9fa48("3917") ? "" : (stryCov_9fa48("3917"), "Direct Grant creation requires a live direct-origin record"));
            }
          }
          requireCanonicalScope(store, grant.scope);
          requireGrantSubject(store, grant);
          validateDelegation(store, grant);
          store.putGrant(grant);
          this.bump(store, stryMutAct_9fa48("3918") ? [] : (stryCov_9fa48("3918"), [stryMutAct_9fa48("3919") ? {} : (stryCov_9fa48("3919"), {
            kind: stryMutAct_9fa48("3920") ? "" : (stryCov_9fa48("3920"), "grant"),
            scope: grant.scope
          })]));
          return grant;
        }
      });
    }
  }
  public revokeGrant(id: GrantId): Grant {
    if (stryMutAct_9fa48("3921")) {
      {}
    } else {
      stryCov_9fa48("3921");
      return this.store.transaction(store => {
        if (stryMutAct_9fa48("3922")) {
          {}
        } else {
          stryCov_9fa48("3922");
          const current = requireRecord(store.grant(id), stryMutAct_9fa48("3923") ? "" : (stryCov_9fa48("3923"), "Grant"));
          if (stryMutAct_9fa48("3926") ? false : stryMutAct_9fa48("3925") ? true : stryMutAct_9fa48("3924") ? current.isLive : (stryCov_9fa48("3924", "3925", "3926"), !current.isLive)) return current;
          const revoked = revokeGrantClosure(store, stryMutAct_9fa48("3927") ? [] : (stryCov_9fa48("3927"), [current.id]));
          this.bump(store, revoked.map(stryMutAct_9fa48("3928") ? () => undefined : (stryCov_9fa48("3928"), grant => stryMutAct_9fa48("3929") ? {} : (stryCov_9fa48("3929"), {
            kind: stryMutAct_9fa48("3930") ? "" : (stryCov_9fa48("3930"), "grant"),
            scope: grant.scope
          }))));
          return requireRecord(store.grant(id), stryMutAct_9fa48("3931") ? "" : (stryCov_9fa48("3931"), "Grant"));
        }
      });
    }
  }
  private reconcile(store: AuthorityMutationStore, membership: Membership, role: Role): readonly ScopeEpoch["scope"][] {
    if (stryMutAct_9fa48("3932")) {
      {}
    } else {
      stryCov_9fa48("3932");
      const previous = new Map(store.grants().map(stryMutAct_9fa48("3933") ? () => undefined : (stryCov_9fa48("3933"), grant => stryMutAct_9fa48("3934") ? [] : (stryCov_9fa48("3934"), [grant.id.value, grant]))));
      const materialization = this.#materializer.materialize(stryMutAct_9fa48("3935") ? {} : (stryCov_9fa48("3935"), {
        membership,
        role,
        existing: store.grants()
      }));
      for (const grant of materialization.changedRecords) store.putGrant(grant);
      const replaced = stryMutAct_9fa48("3936") ? materialization.changedRecords.map(grant => grant.id) : (stryCov_9fa48("3936"), materialization.changedRecords.filter(stryMutAct_9fa48("3937") ? () => undefined : (stryCov_9fa48("3937"), grant => previous.has(grant.id.value))).map(stryMutAct_9fa48("3938") ? () => undefined : (stryCov_9fa48("3938"), grant => grant.id)));
      const descendants = revokeGrantClosure(store, replaced, new Set(replaced.map(stryMutAct_9fa48("3939") ? () => undefined : (stryCov_9fa48("3939"), id => id.value))));
      return distinctScopes(stryMutAct_9fa48("3940") ? [] : (stryCov_9fa48("3940"), [...materialization.affectedScopes, ...descendants.map(stryMutAct_9fa48("3941") ? () => undefined : (stryCov_9fa48("3941"), grant => grant.scope))]));
    }
  }
  private revokeGuestMemberships(store: AuthorityMutationStore, trust: GuestTrust): void {
    if (stryMutAct_9fa48("3942")) {
      {}
    } else {
      stryCov_9fa48("3942");
      const affected = new Map<string, ScopeRef>();
      for (const membership of store.memberships()) {
        if (stryMutAct_9fa48("3943")) {
          {}
        } else {
          stryCov_9fa48("3943");
          if (stryMutAct_9fa48("3946") ? (membership.subject.kind !== "foreign" || membership.guestVerification === undefined || !membership.guestVerification.trustId.equals(trust.id)) && membership.state === "revoked" : stryMutAct_9fa48("3945") ? false : stryMutAct_9fa48("3944") ? true : (stryCov_9fa48("3944", "3945", "3946"), (stryMutAct_9fa48("3948") ? (membership.subject.kind !== "foreign" || membership.guestVerification === undefined) && !membership.guestVerification.trustId.equals(trust.id) : stryMutAct_9fa48("3947") ? false : (stryCov_9fa48("3947", "3948"), (stryMutAct_9fa48("3950") ? membership.subject.kind !== "foreign" && membership.guestVerification === undefined : stryMutAct_9fa48("3949") ? false : (stryCov_9fa48("3949", "3950"), (stryMutAct_9fa48("3952") ? membership.subject.kind === "foreign" : stryMutAct_9fa48("3951") ? false : (stryCov_9fa48("3951", "3952"), membership.subject.kind !== (stryMutAct_9fa48("3953") ? "" : (stryCov_9fa48("3953"), "foreign")))) || (stryMutAct_9fa48("3955") ? membership.guestVerification !== undefined : stryMutAct_9fa48("3954") ? false : (stryCov_9fa48("3954", "3955"), membership.guestVerification === undefined)))) || (stryMutAct_9fa48("3956") ? membership.guestVerification.trustId.equals(trust.id) : (stryCov_9fa48("3956"), !membership.guestVerification.trustId.equals(trust.id))))) || (stryMutAct_9fa48("3958") ? membership.state !== "revoked" : stryMutAct_9fa48("3957") ? false : (stryCov_9fa48("3957", "3958"), membership.state === (stryMutAct_9fa48("3959") ? "" : (stryCov_9fa48("3959"), "revoked")))))) continue;
          const role = requireRecord(store.role(membership.role), stryMutAct_9fa48("3960") ? "" : (stryCov_9fa48("3960"), "Role"));
          const revoked = membership.revoke();
          for (const scope of this.reconcile(store, revoked, role)) {
            if (stryMutAct_9fa48("3961")) {
              {}
            } else {
              stryCov_9fa48("3961");
              affected.set(scopeKey(scope), scope);
            }
          }
          store.putMembership(revoked);
          affected.set(scopeKey(membership.scope), membership.scope);
        }
      }
      this.bump(store, closureMutation(stryMutAct_9fa48("3962") ? "" : (stryCov_9fa48("3962"), "guestVerification"), stryMutAct_9fa48("3963") ? [] : (stryCov_9fa48("3963"), [...affected.values()])));
    }
  }
  private bump(store: AuthorityMutationStore, mutations: readonly ResolverInputMutation[]): readonly ScopeEpoch[] {
    if (stryMutAct_9fa48("3964")) {
      {}
    } else {
      stryCov_9fa48("3964");
      if (stryMutAct_9fa48("3967") ? mutations.length !== 0 : stryMutAct_9fa48("3966") ? false : stryMutAct_9fa48("3965") ? true : (stryCov_9fa48("3965", "3966", "3967"), mutations.length === 0)) return stryMutAct_9fa48("3968") ? ["Stryker was here"] : (stryCov_9fa48("3968"), []);
      const plan = this.#planner.plan(store.epochs(), mutations);
      for (const epoch of plan.bumped) store.putEpoch(epoch);
      return plan.bumped;
    }
  }
}
function validateDelegation(store: AuthorityMutationStore, grant: Grant): void {
  if (stryMutAct_9fa48("3969")) {
    {}
  } else {
    stryCov_9fa48("3969");
    if (stryMutAct_9fa48("3972") ? grant.attenuationOf !== undefined : stryMutAct_9fa48("3971") ? false : stryMutAct_9fa48("3970") ? true : (stryCov_9fa48("3970", "3971", "3972"), grant.attenuationOf === undefined)) return;
    const parent = requireRecord(store.grant(grant.attenuationOf), stryMutAct_9fa48("3973") ? "" : (stryCov_9fa48("3973"), "Parent Grant"));
    if (stryMutAct_9fa48("3976") ? false : stryMutAct_9fa48("3975") ? true : stryMutAct_9fa48("3974") ? parent.canAttenuate(grant) : (stryCov_9fa48("3974", "3975", "3976"), !parent.canAttenuate(grant))) {
      if (stryMutAct_9fa48("3977")) {
        {}
      } else {
        stryCov_9fa48("3977");
        throw new AgentCoreError(stryMutAct_9fa48("3978") ? "" : (stryCov_9fa48("3978"), "authority.denied"), stryMutAct_9fa48("3979") ? "" : (stryCov_9fa48("3979"), "Delegated Grant is not a live attenuation"));
      }
    }
  }
}
function principalScopes(store: AuthorityMutationStore, principalId: PrincipalId): readonly ScopeEpoch["scope"][] {
  if (stryMutAct_9fa48("3980")) {
    {}
  } else {
    stryCov_9fa48("3980");
    const teamIds = new Set(stryMutAct_9fa48("3981") ? store.teams().map(team => team.id.value) : (stryCov_9fa48("3981"), store.teams().filter(stryMutAct_9fa48("3982") ? () => undefined : (stryCov_9fa48("3982"), team => team.has(principalId))).map(stryMutAct_9fa48("3983") ? () => undefined : (stryCov_9fa48("3983"), team => team.id.value))));
    return distinctScopes(stryMutAct_9fa48("3984") ? store.grants().map(grant => grant.scope) : (stryCov_9fa48("3984"), store.grants().filter(stryMutAct_9fa48("3985") ? () => undefined : (stryCov_9fa48("3985"), grant => (stryMutAct_9fa48("3988") ? grant.subject.kind !== "principal" : stryMutAct_9fa48("3987") ? false : stryMutAct_9fa48("3986") ? true : (stryCov_9fa48("3986", "3987", "3988"), grant.subject.kind === (stryMutAct_9fa48("3989") ? "" : (stryCov_9fa48("3989"), "principal")))) ? grant.subject.principalId.equals(principalId) : stryMutAct_9fa48("3992") ? grant.subject.kind === "team" || teamIds.has(grant.subject.teamId.value) : stryMutAct_9fa48("3991") ? false : stryMutAct_9fa48("3990") ? true : (stryCov_9fa48("3990", "3991", "3992"), (stryMutAct_9fa48("3994") ? grant.subject.kind !== "team" : stryMutAct_9fa48("3993") ? true : (stryCov_9fa48("3993", "3994"), grant.subject.kind === (stryMutAct_9fa48("3995") ? "" : (stryCov_9fa48("3995"), "team")))) && teamIds.has(grant.subject.teamId.value)))).map(stryMutAct_9fa48("3996") ? () => undefined : (stryCov_9fa48("3996"), grant => grant.scope))));
  }
}
function teamScopes(store: AuthorityMutationStore, teamId: TeamId): readonly ScopeEpoch["scope"][] {
  if (stryMutAct_9fa48("3997")) {
    {}
  } else {
    stryCov_9fa48("3997");
    const key = subjectKey(stryMutAct_9fa48("3998") ? {} : (stryCov_9fa48("3998"), {
      kind: stryMutAct_9fa48("3999") ? "" : (stryCov_9fa48("3999"), "team"),
      teamId
    }));
    return distinctScopes(stryMutAct_9fa48("4000") ? [] : (stryCov_9fa48("4000"), [...(stryMutAct_9fa48("4001") ? store.grants().map(grant => grant.scope) : (stryCov_9fa48("4001"), store.grants().filter(stryMutAct_9fa48("4002") ? () => undefined : (stryCov_9fa48("4002"), grant => stryMutAct_9fa48("4005") ? subjectKey(grant.subject) !== key : stryMutAct_9fa48("4004") ? false : stryMutAct_9fa48("4003") ? true : (stryCov_9fa48("4003", "4004", "4005"), subjectKey(grant.subject) === key))).map(stryMutAct_9fa48("4006") ? () => undefined : (stryCov_9fa48("4006"), grant => grant.scope)))), ...(stryMutAct_9fa48("4007") ? store.memberships().map(membership => membership.scope) : (stryCov_9fa48("4007"), store.memberships().filter(stryMutAct_9fa48("4008") ? () => undefined : (stryCov_9fa48("4008"), membership => stryMutAct_9fa48("4011") ? subjectKey(membership.subject) !== key : stryMutAct_9fa48("4010") ? false : stryMutAct_9fa48("4009") ? true : (stryCov_9fa48("4009", "4010", "4011"), subjectKey(membership.subject) === key))).map(stryMutAct_9fa48("4012") ? () => undefined : (stryCov_9fa48("4012"), membership => membership.scope))))]));
  }
}
function closureMutation(kind: "guestVerification" | "principalClosure" | "role" | "teamClosure", scopes: readonly ScopeEpoch["scope"][]): readonly ResolverInputMutation[] {
  if (stryMutAct_9fa48("4013")) {
    {}
  } else {
    stryCov_9fa48("4013");
    return (stryMutAct_9fa48("4016") ? scopes.length !== 0 : stryMutAct_9fa48("4015") ? false : stryMutAct_9fa48("4014") ? true : (stryCov_9fa48("4014", "4015", "4016"), scopes.length === 0)) ? stryMutAct_9fa48("4017") ? ["Stryker was here"] : (stryCov_9fa48("4017"), []) : stryMutAct_9fa48("4018") ? [] : (stryCov_9fa48("4018"), [stryMutAct_9fa48("4019") ? {} : (stryCov_9fa48("4019"), {
      kind,
      affectedScopes: nonEmpty(scopes)
    })]);
  }
}
function distinctScopes(scopes: readonly ScopeEpoch["scope"][]): readonly ScopeEpoch["scope"][] {
  if (stryMutAct_9fa48("4020")) {
    {}
  } else {
    stryCov_9fa48("4020");
    return stryMutAct_9fa48("4021") ? [] : (stryCov_9fa48("4021"), [...new Map(scopes.map(stryMutAct_9fa48("4022") ? () => undefined : (stryCov_9fa48("4022"), scope => stryMutAct_9fa48("4023") ? [] : (stryCov_9fa48("4023"), [scopeKey(scope), scope])))).values()]);
  }
}
function nonEmpty<Scopes extends ScopeEpoch["scope"]>(scopes: readonly Scopes[]): readonly [Scopes, ...Scopes[]] {
  if (stryMutAct_9fa48("4024")) {
    {}
  } else {
    stryCov_9fa48("4024");
    const distinct = distinctScopes(scopes) as readonly Scopes[];
    if (stryMutAct_9fa48("4027") ? distinct.length !== 0 : stryMutAct_9fa48("4026") ? false : stryMutAct_9fa48("4025") ? true : (stryCov_9fa48("4025", "4026", "4027"), distinct.length === 0)) {
      if (stryMutAct_9fa48("4028")) {
        {}
      } else {
        stryCov_9fa48("4028");
        throw new AgentCoreError(stryMutAct_9fa48("4029") ? "" : (stryCov_9fa48("4029"), "protocol.invalid-state"), stryMutAct_9fa48("4030") ? "" : (stryCov_9fa48("4030"), "Authority mutations require an affected Scope"));
      }
    }
    return distinct as readonly [Scopes, ...Scopes[]];
  }
}
function requireRecord<Record>(record: Record | undefined, name: string): Record {
  if (stryMutAct_9fa48("4031")) {
    {}
  } else {
    stryCov_9fa48("4031");
    if (stryMutAct_9fa48("4034") ? record !== undefined : stryMutAct_9fa48("4033") ? false : stryMutAct_9fa48("4032") ? true : (stryCov_9fa48("4032", "4033", "4034"), record === undefined)) {
      if (stryMutAct_9fa48("4035")) {
        {}
      } else {
        stryCov_9fa48("4035");
        throw new AgentCoreError(stryMutAct_9fa48("4036") ? "" : (stryCov_9fa48("4036"), "protocol.invalid-state"), stryMutAct_9fa48("4037") ? `` : (stryCov_9fa48("4037"), `${name} does not exist`));
      }
    }
    return record;
  }
}
function requireAbsent(record: unknown | undefined, name: string): void {
  if (stryMutAct_9fa48("4038")) {
    {}
  } else {
    stryCov_9fa48("4038");
    if (stryMutAct_9fa48("4041") ? record === undefined : stryMutAct_9fa48("4040") ? false : stryMutAct_9fa48("4039") ? true : (stryCov_9fa48("4039", "4040", "4041"), record !== undefined)) {
      if (stryMutAct_9fa48("4042")) {
        {}
      } else {
        stryCov_9fa48("4042");
        throw new AgentCoreError(stryMutAct_9fa48("4043") ? "" : (stryCov_9fa48("4043"), "protocol.invalid-state"), stryMutAct_9fa48("4044") ? `` : (stryCov_9fa48("4044"), `${name} already exists`));
      }
    }
  }
}
function requirePrincipals(store: AuthorityMutationStore, principals: readonly PrincipalId[]): void {
  if (stryMutAct_9fa48("4045")) {
    {}
  } else {
    stryCov_9fa48("4045");
    for (const principal of principals) requireRecord(store.principal(principal), stryMutAct_9fa48("4046") ? "" : (stryCov_9fa48("4046"), "Principal"));
  }
}
function requireCanonicalScope(store: AuthorityMutationStore, scope: ScopeEpoch["scope"]): void {
  if (stryMutAct_9fa48("4047")) {
    {}
  } else {
    stryCov_9fa48("4047");
    if (stryMutAct_9fa48("4050") ? false : stryMutAct_9fa48("4049") ? true : stryMutAct_9fa48("4048") ? scope.tenantId.equals(store.tenantId) : (stryCov_9fa48("4048", "4049", "4050"), !scope.tenantId.equals(store.tenantId))) {
      if (stryMutAct_9fa48("4051")) {
        {}
      } else {
        stryCov_9fa48("4051");
        throw new AgentCoreError(stryMutAct_9fa48("4052") ? "" : (stryCov_9fa48("4052"), "protocol.invalid-state"), stryMutAct_9fa48("4053") ? "" : (stryCov_9fa48("4053"), "Authority Scope belongs to another Tenant"));
      }
    }
    if (stryMutAct_9fa48("4056") ? scope.kind === "project" || scope.projectId === undefined || store.project(scope.projectId) === undefined : stryMutAct_9fa48("4055") ? false : stryMutAct_9fa48("4054") ? true : (stryCov_9fa48("4054", "4055", "4056"), (stryMutAct_9fa48("4058") ? scope.kind !== "project" : stryMutAct_9fa48("4057") ? true : (stryCov_9fa48("4057", "4058"), scope.kind === (stryMutAct_9fa48("4059") ? "" : (stryCov_9fa48("4059"), "project")))) && (stryMutAct_9fa48("4061") ? scope.projectId === undefined && store.project(scope.projectId) === undefined : stryMutAct_9fa48("4060") ? true : (stryCov_9fa48("4060", "4061"), (stryMutAct_9fa48("4063") ? scope.projectId !== undefined : stryMutAct_9fa48("4062") ? false : (stryCov_9fa48("4062", "4063"), scope.projectId === undefined)) || (stryMutAct_9fa48("4065") ? store.project(scope.projectId) !== undefined : stryMutAct_9fa48("4064") ? false : (stryCov_9fa48("4064", "4065"), store.project(scope.projectId) === undefined)))))) {
      if (stryMutAct_9fa48("4066")) {
        {}
      } else {
        stryCov_9fa48("4066");
        throw new AgentCoreError(stryMutAct_9fa48("4067") ? "" : (stryCov_9fa48("4067"), "protocol.invalid-state"), stryMutAct_9fa48("4068") ? "" : (stryCov_9fa48("4068"), "Authority Project Scope is not canonical"));
      }
    }
    if (stryMutAct_9fa48("4071") ? scope.kind !== "workspace" : stryMutAct_9fa48("4070") ? false : stryMutAct_9fa48("4069") ? true : (stryCov_9fa48("4069", "4070", "4071"), scope.kind === (stryMutAct_9fa48("4072") ? "" : (stryCov_9fa48("4072"), "workspace")))) {
      if (stryMutAct_9fa48("4073")) {
        {}
      } else {
        stryCov_9fa48("4073");
        const workspace = (stryMutAct_9fa48("4076") ? scope.workspaceId !== undefined : stryMutAct_9fa48("4075") ? false : stryMutAct_9fa48("4074") ? true : (stryCov_9fa48("4074", "4075", "4076"), scope.workspaceId === undefined)) ? undefined : store.workspace(scope.workspaceId);
        if (stryMutAct_9fa48("4079") ? workspace === undefined && !workspace.scope.equals(scope) : stryMutAct_9fa48("4078") ? false : stryMutAct_9fa48("4077") ? true : (stryCov_9fa48("4077", "4078", "4079"), (stryMutAct_9fa48("4081") ? workspace !== undefined : stryMutAct_9fa48("4080") ? false : (stryCov_9fa48("4080", "4081"), workspace === undefined)) || (stryMutAct_9fa48("4082") ? workspace.scope.equals(scope) : (stryCov_9fa48("4082"), !workspace.scope.equals(scope))))) {
          if (stryMutAct_9fa48("4083")) {
            {}
          } else {
            stryCov_9fa48("4083");
            throw new AgentCoreError(stryMutAct_9fa48("4084") ? "" : (stryCov_9fa48("4084"), "protocol.invalid-state"), stryMutAct_9fa48("4085") ? "" : (stryCov_9fa48("4085"), "Authority Workspace Scope is not canonical"));
          }
        }
      }
    }
  }
}
function requireMembershipSubject(store: AuthorityMutationStore, membership: Membership): void {
  if (stryMutAct_9fa48("4086")) {
    {}
  } else {
    stryCov_9fa48("4086");
    if (stryMutAct_9fa48("4089") ? membership.subject.kind !== "principal" : stryMutAct_9fa48("4088") ? false : stryMutAct_9fa48("4087") ? true : (stryCov_9fa48("4087", "4088", "4089"), membership.subject.kind === (stryMutAct_9fa48("4090") ? "" : (stryCov_9fa48("4090"), "principal")))) {
      if (stryMutAct_9fa48("4091")) {
        {}
      } else {
        stryCov_9fa48("4091");
        requireRecord(store.principal(membership.subject.principalId), stryMutAct_9fa48("4092") ? "" : (stryCov_9fa48("4092"), "Principal"));
      }
    } else if (stryMutAct_9fa48("4095") ? membership.subject.kind !== "team" : stryMutAct_9fa48("4094") ? false : stryMutAct_9fa48("4093") ? true : (stryCov_9fa48("4093", "4094", "4095"), membership.subject.kind === (stryMutAct_9fa48("4096") ? "" : (stryCov_9fa48("4096"), "team")))) {
      if (stryMutAct_9fa48("4097")) {
        {}
      } else {
        stryCov_9fa48("4097");
        requireRecord(store.team(membership.subject.teamId), stryMutAct_9fa48("4098") ? "" : (stryCov_9fa48("4098"), "Team"));
      }
    }
  }
}
function requireGrantSubject(store: AuthorityMutationStore, grant: Grant): void {
  if (stryMutAct_9fa48("4099")) {
    {}
  } else {
    stryCov_9fa48("4099");
    if (stryMutAct_9fa48("4102") ? grant.subject.kind !== "principal" : stryMutAct_9fa48("4101") ? false : stryMutAct_9fa48("4100") ? true : (stryCov_9fa48("4100", "4101", "4102"), grant.subject.kind === (stryMutAct_9fa48("4103") ? "" : (stryCov_9fa48("4103"), "principal")))) {
      if (stryMutAct_9fa48("4104")) {
        {}
      } else {
        stryCov_9fa48("4104");
        requireRecord(store.principal(grant.subject.principalId), stryMutAct_9fa48("4105") ? "" : (stryCov_9fa48("4105"), "Principal"));
      }
    } else if (stryMutAct_9fa48("4108") ? grant.subject.kind !== "team" : stryMutAct_9fa48("4107") ? false : stryMutAct_9fa48("4106") ? true : (stryCov_9fa48("4106", "4107", "4108"), grant.subject.kind === (stryMutAct_9fa48("4109") ? "" : (stryCov_9fa48("4109"), "team")))) {
      if (stryMutAct_9fa48("4110")) {
        {}
      } else {
        stryCov_9fa48("4110");
        requireRecord(store.team(grant.subject.teamId), stryMutAct_9fa48("4111") ? "" : (stryCov_9fa48("4111"), "Team"));
      }
    } else {
      if (stryMutAct_9fa48("4112")) {
        {}
      } else {
        stryCov_9fa48("4112");
        throw new AgentCoreError(stryMutAct_9fa48("4113") ? "" : (stryCov_9fa48("4113"), "protocol.invalid-state"), stryMutAct_9fa48("4114") ? "" : (stryCov_9fa48("4114"), "Guest Grant verification is not implemented"));
      }
    }
  }
}
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (stryMutAct_9fa48("4115")) {
    {}
  } else {
    stryCov_9fa48("4115");
    return stryMutAct_9fa48("4118") ? left.byteLength === right.byteLength || left.every((value, index) => value === right[index]) : stryMutAct_9fa48("4117") ? false : stryMutAct_9fa48("4116") ? true : (stryCov_9fa48("4116", "4117", "4118"), (stryMutAct_9fa48("4120") ? left.byteLength !== right.byteLength : stryMutAct_9fa48("4119") ? true : (stryCov_9fa48("4119", "4120"), left.byteLength === right.byteLength)) && (stryMutAct_9fa48("4121") ? left.some((value, index) => value === right[index]) : (stryCov_9fa48("4121"), left.every(stryMutAct_9fa48("4122") ? () => undefined : (stryCov_9fa48("4122"), (value, index) => stryMutAct_9fa48("4125") ? value !== right[index] : stryMutAct_9fa48("4124") ? false : stryMutAct_9fa48("4123") ? true : (stryCov_9fa48("4123", "4124", "4125"), value === right[index]))))));
  }
}
function deterministicOwnerMembershipId(anchor: TenantControlBootstrapAnchor): MembershipId {
  if (stryMutAct_9fa48("4126")) {
    {}
  } else {
    stryCov_9fa48("4126");
    const digest = Digest.sha256(encodeCanonicalJson(stryMutAct_9fa48("4127") ? {} : (stryCov_9fa48("4127"), {
      actorId: anchor.actorId.value,
      principalId: anchor.principalId.value,
      tenantId: anchor.tenantId.value,
      trustAnchor: encodeBase64(anchor.trustAnchor)
    })));
    return new MembershipId(stryMutAct_9fa48("4128") ? `` : (stryCov_9fa48("4128"), `bootstrap:${digest.value}`));
  }
}
function revokeGrantClosure(store: AuthorityMutationStore, roots: readonly GrantId[], skip = new Set<string>()): readonly Grant[] {
  if (stryMutAct_9fa48("4129")) {
    {}
  } else {
    stryCov_9fa48("4129");
    const revoked: Grant[] = stryMutAct_9fa48("4130") ? ["Stryker was here"] : (stryCov_9fa48("4130"), []);
    const pending = roots.map(stryMutAct_9fa48("4131") ? () => undefined : (stryCov_9fa48("4131"), id => id.value));
    const visited = new Set<string>();
    while (stryMutAct_9fa48("4134") ? pending.length <= 0 : stryMutAct_9fa48("4133") ? pending.length >= 0 : stryMutAct_9fa48("4132") ? false : (stryCov_9fa48("4132", "4133", "4134"), pending.length > 0)) {
      if (stryMutAct_9fa48("4135")) {
        {}
      } else {
        stryCov_9fa48("4135");
        const parent = pending.pop()!;
        if (stryMutAct_9fa48("4137") ? false : stryMutAct_9fa48("4136") ? true : (stryCov_9fa48("4136", "4137"), visited.has(parent))) continue;
        visited.add(parent);
        for (const grant of stryMutAct_9fa48("4138") ? store.grants() : (stryCov_9fa48("4138"), store.grants().filter(stryMutAct_9fa48("4139") ? () => undefined : (stryCov_9fa48("4139"), candidate => stryMutAct_9fa48("4142") ? candidate.attenuationOf?.value !== parent : stryMutAct_9fa48("4141") ? false : stryMutAct_9fa48("4140") ? true : (stryCov_9fa48("4140", "4141", "4142"), (stryMutAct_9fa48("4143") ? candidate.attenuationOf.value : (stryCov_9fa48("4143"), candidate.attenuationOf?.value)) === parent))))) {
          if (stryMutAct_9fa48("4144")) {
            {}
          } else {
            stryCov_9fa48("4144");
            pending.push(grant.id.value);
            if (stryMutAct_9fa48("4147") ? !grant.isLive && skip.has(grant.id.value) : stryMutAct_9fa48("4146") ? false : stryMutAct_9fa48("4145") ? true : (stryCov_9fa48("4145", "4146", "4147"), (stryMutAct_9fa48("4148") ? grant.isLive : (stryCov_9fa48("4148"), !grant.isLive)) || skip.has(grant.id.value))) continue;
            const next = grant.revoke();
            store.putGrant(next);
            revoked.push(next);
          }
        }
      }
    }
    for (const id of roots) {
      if (stryMutAct_9fa48("4149")) {
        {}
      } else {
        stryCov_9fa48("4149");
        if (stryMutAct_9fa48("4151") ? false : stryMutAct_9fa48("4150") ? true : (stryCov_9fa48("4150", "4151"), skip.has(id.value))) continue;
        const grant = store.grant(id);
        if (stryMutAct_9fa48("4154") ? grant?.isLive === true : stryMutAct_9fa48("4153") ? false : stryMutAct_9fa48("4152") ? true : (stryCov_9fa48("4152", "4153", "4154"), (stryMutAct_9fa48("4155") ? grant.isLive : (stryCov_9fa48("4155"), grant?.isLive)) !== (stryMutAct_9fa48("4156") ? false : (stryCov_9fa48("4156"), true)))) continue;
        const next = grant.revoke();
        store.putGrant(next);
        revoked.push(next);
      }
    }
    return Object.freeze(revoked);
  }
}