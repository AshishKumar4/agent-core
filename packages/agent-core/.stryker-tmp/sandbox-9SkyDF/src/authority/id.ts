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
import { Digest, TextId, encodeCanonicalJson } from "../core";
type IdentityIdInput = string | {
  readonly value: string;
};
export class GrantId extends TextId {
  public constructor(value: string) {
    if (stryMutAct_9fa48("1481")) {
      {}
    } else {
      stryCov_9fa48("1481");
      super(value, stryMutAct_9fa48("1482") ? "" : (stryCov_9fa48("1482"), "Grant ID"));
      Object.freeze(this);
    }
  }
  public static forRole(membership: IdentityIdInput, ruleOrdinal: number): GrantId {
    if (stryMutAct_9fa48("1483")) {
      {}
    } else {
      stryCov_9fa48("1483");
      validateRoleRuleOrdinal(ruleOrdinal);
      const membershipId = validateIdentityIdValue(membership, stryMutAct_9fa48("1484") ? "" : (stryCov_9fa48("1484"), "Membership ID"));
      const digest = Digest.sha256(encodeCanonicalJson(stryMutAct_9fa48("1485") ? {} : (stryCov_9fa48("1485"), {
        membership: membershipId,
        ruleOrdinal
      })));
      return new GrantId(stryMutAct_9fa48("1486") ? `` : (stryCov_9fa48("1486"), `role:${digest.value}`));
    }
  }
}
function validateRoleRuleOrdinal(ruleOrdinal: number): void {
  if (stryMutAct_9fa48("1487")) {
    {}
  } else {
    stryCov_9fa48("1487");
    if (stryMutAct_9fa48("1490") ? !Number.isSafeInteger(ruleOrdinal) && ruleOrdinal < 0 : stryMutAct_9fa48("1489") ? false : stryMutAct_9fa48("1488") ? true : (stryCov_9fa48("1488", "1489", "1490"), (stryMutAct_9fa48("1491") ? Number.isSafeInteger(ruleOrdinal) : (stryCov_9fa48("1491"), !Number.isSafeInteger(ruleOrdinal))) || (stryMutAct_9fa48("1494") ? ruleOrdinal >= 0 : stryMutAct_9fa48("1493") ? ruleOrdinal <= 0 : stryMutAct_9fa48("1492") ? false : (stryCov_9fa48("1492", "1493", "1494"), ruleOrdinal < 0)))) {
      if (stryMutAct_9fa48("1495")) {
        {}
      } else {
        stryCov_9fa48("1495");
        throw new TypeError(stryMutAct_9fa48("1496") ? "" : (stryCov_9fa48("1496"), "Role rule ordinal must be a non-negative safe integer"));
      }
    }
  }
}
function validateIdentityIdValue(value: IdentityIdInput, name: string): string {
  if (stryMutAct_9fa48("1497")) {
    {}
  } else {
    stryCov_9fa48("1497");
    const result = (stryMutAct_9fa48("1500") ? typeof value !== "string" : stryMutAct_9fa48("1499") ? false : stryMutAct_9fa48("1498") ? true : (stryCov_9fa48("1498", "1499", "1500"), typeof value === (stryMutAct_9fa48("1501") ? "" : (stryCov_9fa48("1501"), "string")))) ? value : value.value;
    if (stryMutAct_9fa48("1504") ? result.length === 0 && result.length > 256 : stryMutAct_9fa48("1503") ? false : stryMutAct_9fa48("1502") ? true : (stryCov_9fa48("1502", "1503", "1504"), (stryMutAct_9fa48("1506") ? result.length !== 0 : stryMutAct_9fa48("1505") ? false : (stryCov_9fa48("1505", "1506"), result.length === 0)) || (stryMutAct_9fa48("1509") ? result.length <= 256 : stryMutAct_9fa48("1508") ? result.length >= 256 : stryMutAct_9fa48("1507") ? false : (stryCov_9fa48("1507", "1508", "1509"), result.length > 256)))) {
      if (stryMutAct_9fa48("1510")) {
        {}
      } else {
        stryCov_9fa48("1510");
        throw new TypeError(stryMutAct_9fa48("1511") ? `` : (stryCov_9fa48("1511"), `${name} must contain between 1 and 256 characters`));
      }
    }
    return result;
  }
}