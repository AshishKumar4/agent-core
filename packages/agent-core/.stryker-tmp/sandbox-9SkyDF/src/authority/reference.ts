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
import { decodeScopeRef, decodeSubjectRef, encodeScopeRef, encodeSubjectRef, type ScopeRef, type SubjectRef } from "../identity";
import type { JsonValue } from "../core";
import { authorityKey } from "./key";
export type { ScopeRef, SubjectRef } from "../identity";
export function scopeKey(scope: ScopeRef): string {
  if (stryMutAct_9fa48("3294")) {
    {}
  } else {
    stryCov_9fa48("3294");
    return authorityKey(stryMutAct_9fa48("3295") ? "" : (stryCov_9fa48("3295"), "scope"), stryMutAct_9fa48("3296") ? [] : (stryCov_9fa48("3296"), [encodeScopeRef(scope)]));
  }
}
export function subjectKey(subject: SubjectRef): string {
  if (stryMutAct_9fa48("3297")) {
    {}
  } else {
    stryCov_9fa48("3297");
    return authorityKey(stryMutAct_9fa48("3298") ? "" : (stryCov_9fa48("3298"), "subject"), stryMutAct_9fa48("3299") ? [] : (stryCov_9fa48("3299"), [encodeSubjectRef(subject)]));
  }
}
export function encodeAuthorityScope(scope: ScopeRef): JsonValue {
  if (stryMutAct_9fa48("3300")) {
    {}
  } else {
    stryCov_9fa48("3300");
    return encodeScopeRef(scope);
  }
}
export function decodeAuthorityScope(value: JsonValue): ScopeRef {
  if (stryMutAct_9fa48("3301")) {
    {}
  } else {
    stryCov_9fa48("3301");
    return decodeScopeRef(value);
  }
}
export function encodeAuthoritySubject(subject: SubjectRef): JsonValue {
  if (stryMutAct_9fa48("3302")) {
    {}
  } else {
    stryCov_9fa48("3302");
    return encodeSubjectRef(subject);
  }
}
export function decodeAuthoritySubject(value: JsonValue): SubjectRef {
  if (stryMutAct_9fa48("3303")) {
    {}
  } else {
    stryCov_9fa48("3303");
    return decodeSubjectRef(value);
  }
}