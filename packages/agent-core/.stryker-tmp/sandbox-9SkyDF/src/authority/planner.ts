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
import type { ScopeRef } from "../identity";
import { AgentCoreError } from "../errors";
import { ScopeEpoch } from "./epoch";
import { scopeKey } from "./reference";
type NonEmptyScopes = readonly [ScopeRef, ...ScopeRef[]];
export type ResolverInputMutation = {
  readonly kind: "grant";
  readonly scope: ScopeRef;
} | {
  readonly kind: "membership";
  readonly affectedScopes: NonEmptyScopes;
} | {
  readonly kind: "role";
  readonly affectedScopes: NonEmptyScopes;
} | {
  readonly kind: "teamClosure";
  readonly affectedScopes: NonEmptyScopes;
} | {
  readonly kind: "principalClosure";
  readonly affectedScopes: NonEmptyScopes;
} | {
  readonly kind: "guestVerification";
  readonly affectedScopes: NonEmptyScopes;
} | {
  readonly kind: "topology";
  readonly affectedScopes: NonEmptyScopes;
} | {
  readonly kind: "lifecycle";
  readonly affectedScopes: NonEmptyScopes;
} | {
  readonly kind: "policy";
  readonly affectedScopes: NonEmptyScopes;
} | {
  readonly kind: "trust";
  readonly affectedScopes: NonEmptyScopes;
} | {
  readonly kind: "bindingTransition";
  readonly affectedScopes: NonEmptyScopes;
};
export class EpochPlan {
  public readonly next: readonly ScopeEpoch[];
  public readonly bumped: readonly ScopeEpoch[];
  public readonly affectedScopes: readonly ScopeRef[];
  public constructor(next: readonly ScopeEpoch[], bumped: readonly ScopeEpoch[]) {
    if (stryMutAct_9fa48("3242")) {
      {}
    } else {
      stryCov_9fa48("3242");
      this.next = canonicalEpochs(next);
      this.bumped = canonicalEpochs(bumped);
      this.affectedScopes = Object.freeze(this.bumped.map(stryMutAct_9fa48("3243") ? () => undefined : (stryCov_9fa48("3243"), entry => entry.scope)));
      Object.freeze(this);
    }
  }
}
export class EpochPlanner {
  public plan(current: readonly ScopeEpoch[], mutations: readonly ResolverInputMutation[]): EpochPlan {
    if (stryMutAct_9fa48("3244")) {
      {}
    } else {
      stryCov_9fa48("3244");
      const currentByScope = new Map<string, ScopeEpoch>();
      for (const entry of current) {
        if (stryMutAct_9fa48("3245")) {
          {}
        } else {
          stryCov_9fa48("3245");
          const key = scopeKey(entry.scope);
          if (stryMutAct_9fa48("3247") ? false : stryMutAct_9fa48("3246") ? true : (stryCov_9fa48("3246", "3247"), currentByScope.has(key))) {
            if (stryMutAct_9fa48("3248")) {
              {}
            } else {
              stryCov_9fa48("3248");
              throw new AgentCoreError(stryMutAct_9fa48("3249") ? "" : (stryCov_9fa48("3249"), "protocol.invalid-state"), stryMutAct_9fa48("3250") ? "" : (stryCov_9fa48("3250"), "Current Scope epochs must be unique"));
            }
          }
          currentByScope.set(key, entry);
        }
      }
      const affected = new Map<string, ScopeRef>();
      for (const mutation of mutations) {
        if (stryMutAct_9fa48("3251")) {
          {}
        } else {
          stryCov_9fa48("3251");
          for (const scope of mutationScopes(mutation)) affected.set(scopeKey(scope), scope);
        }
      }
      for (const [key] of affected) {
        if (stryMutAct_9fa48("3252")) {
          {}
        } else {
          stryCov_9fa48("3252");
          if (stryMutAct_9fa48("3255") ? currentByScope.get(key)?.epoch !== Number.MAX_SAFE_INTEGER : stryMutAct_9fa48("3254") ? false : stryMutAct_9fa48("3253") ? true : (stryCov_9fa48("3253", "3254", "3255"), (stryMutAct_9fa48("3256") ? currentByScope.get(key).epoch : (stryCov_9fa48("3256"), currentByScope.get(key)?.epoch)) === Number.MAX_SAFE_INTEGER)) {
            if (stryMutAct_9fa48("3257")) {
              {}
            } else {
              stryCov_9fa48("3257");
              throw new AgentCoreError(stryMutAct_9fa48("3258") ? "" : (stryCov_9fa48("3258"), "protocol.invalid-state"), stryMutAct_9fa48("3259") ? `` : (stryCov_9fa48("3259"), `Authority epoch is exhausted for ${key}`));
            }
          }
        }
      }
      const bumped: ScopeEpoch[] = stryMutAct_9fa48("3260") ? ["Stryker was here"] : (stryCov_9fa48("3260"), []);
      for (const [key, scope] of affected) {
        if (stryMutAct_9fa48("3261")) {
          {}
        } else {
          stryCov_9fa48("3261");
          const next = (stryMutAct_9fa48("3262") ? currentByScope.get(key) && ScopeEpoch.initial(scope) : (stryCov_9fa48("3262"), currentByScope.get(key) ?? ScopeEpoch.initial(scope))).next();
          currentByScope.set(key, next);
          bumped.push(next);
        }
      }
      return new EpochPlan(stryMutAct_9fa48("3263") ? [] : (stryCov_9fa48("3263"), [...currentByScope.values()]), bumped);
    }
  }
}
function mutationScopes(mutation: ResolverInputMutation): readonly ScopeRef[] {
  if (stryMutAct_9fa48("3264")) {
    {}
  } else {
    stryCov_9fa48("3264");
    switch (mutation.kind) {
      case stryMutAct_9fa48("3266") ? "" : (stryCov_9fa48("3266"), "grant"):
        if (stryMutAct_9fa48("3265")) {} else {
          stryCov_9fa48("3265");
          return stryMutAct_9fa48("3267") ? [] : (stryCov_9fa48("3267"), [mutation.scope]);
        }
      case stryMutAct_9fa48("3268") ? "" : (stryCov_9fa48("3268"), "membership"):
      case stryMutAct_9fa48("3269") ? "" : (stryCov_9fa48("3269"), "role"):
      case stryMutAct_9fa48("3270") ? "" : (stryCov_9fa48("3270"), "teamClosure"):
      case stryMutAct_9fa48("3271") ? "" : (stryCov_9fa48("3271"), "principalClosure"):
      case stryMutAct_9fa48("3272") ? "" : (stryCov_9fa48("3272"), "guestVerification"):
      case stryMutAct_9fa48("3273") ? "" : (stryCov_9fa48("3273"), "topology"):
      case stryMutAct_9fa48("3274") ? "" : (stryCov_9fa48("3274"), "lifecycle"):
      case stryMutAct_9fa48("3275") ? "" : (stryCov_9fa48("3275"), "policy"):
      case stryMutAct_9fa48("3276") ? "" : (stryCov_9fa48("3276"), "trust"):
      case stryMutAct_9fa48("3278") ? "" : (stryCov_9fa48("3278"), "bindingTransition"):
        if (stryMutAct_9fa48("3277")) {} else {
          stryCov_9fa48("3277");
          return mutation.affectedScopes;
        }
      default:
        if (stryMutAct_9fa48("3279")) {} else {
          stryCov_9fa48("3279");
          return assertNever(mutation);
        }
    }
  }
}
function canonicalEpochs(entries: readonly ScopeEpoch[]): readonly ScopeEpoch[] {
  if (stryMutAct_9fa48("3280")) {
    {}
  } else {
    stryCov_9fa48("3280");
    const ordered = stryMutAct_9fa48("3281") ? [...entries] : (stryCov_9fa48("3281"), (stryMutAct_9fa48("3282") ? [] : (stryCov_9fa48("3282"), [...entries])).sort(stryMutAct_9fa48("3283") ? () => undefined : (stryCov_9fa48("3283"), (left, right) => scopeKey(left.scope).localeCompare(scopeKey(right.scope)))));
    if (stryMutAct_9fa48("3286") ? new Set(ordered.map(entry => scopeKey(entry.scope))).size === ordered.length : stryMutAct_9fa48("3285") ? false : stryMutAct_9fa48("3284") ? true : (stryCov_9fa48("3284", "3285", "3286"), new Set(ordered.map(stryMutAct_9fa48("3287") ? () => undefined : (stryCov_9fa48("3287"), entry => scopeKey(entry.scope)))).size !== ordered.length)) {
      if (stryMutAct_9fa48("3288")) {
        {}
      } else {
        stryCov_9fa48("3288");
        throw new AgentCoreError(stryMutAct_9fa48("3289") ? "" : (stryCov_9fa48("3289"), "protocol.invalid-state"), stryMutAct_9fa48("3290") ? "" : (stryCov_9fa48("3290"), "Epoch plan Scopes must be unique"));
      }
    }
    return Object.freeze(ordered);
  }
}
function assertNever(value: never): never {
  if (stryMutAct_9fa48("3291")) {
    {}
  } else {
    stryCov_9fa48("3291");
    throw new AgentCoreError(stryMutAct_9fa48("3292") ? "" : (stryCov_9fa48("3292"), "protocol.invalid-state"), stryMutAct_9fa48("3293") ? `` : (stryCov_9fa48("3293"), `Unknown authority mutation ${String(value)}`));
  }
}