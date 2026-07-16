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
import type { Membership, Role, RoleRule } from "../identity";
import { AgentCoreError } from "../errors";
import type { CapabilitySpec } from "../facets";
import { bytesEqual } from "./data";
import { Grant } from "./grant";
import { GrantId } from "./id";
import { scopeKey } from "./reference";
import type { ScopeRef } from "../identity";
export interface RoleGrantMaterializationInput {
  readonly membership: Membership;
  readonly role: Role;
  readonly existing: readonly Grant[];
}
export class RoleGrantMaterialization {
  public readonly desiredRecords: readonly Grant[];
  public readonly changedRecords: readonly Grant[];
  public readonly affectedScopes: readonly ScopeRef[];
  public constructor(desiredRecords: readonly Grant[], changedRecords: readonly Grant[], affectedScopes: readonly ScopeRef[]) {
    if (stryMutAct_9fa48("1518")) {
      {}
    } else {
      stryCov_9fa48("1518");
      this.desiredRecords = canonicalGrants(desiredRecords);
      this.changedRecords = canonicalGrants(changedRecords);
      this.affectedScopes = Object.freeze(stryMutAct_9fa48("1519") ? [...affectedScopes] : (stryCov_9fa48("1519"), (stryMutAct_9fa48("1520") ? [] : (stryCov_9fa48("1520"), [...affectedScopes])).sort(stryMutAct_9fa48("1521") ? () => undefined : (stryCov_9fa48("1521"), (left, right) => scopeKey(left).localeCompare(scopeKey(right))))));
      Object.freeze(this);
    }
  }
  public get semanticNoop(): boolean {
    if (stryMutAct_9fa48("1522")) {
      {}
    } else {
      stryCov_9fa48("1522");
      return stryMutAct_9fa48("1525") ? this.changedRecords.length !== 0 : stryMutAct_9fa48("1524") ? false : stryMutAct_9fa48("1523") ? true : (stryCov_9fa48("1523", "1524", "1525"), this.changedRecords.length === 0);
    }
  }
}
export class RoleGrantMaterializer {
  public materialize(input: RoleGrantMaterializationInput): RoleGrantMaterialization {
    if (stryMutAct_9fa48("1526")) {
      {}
    } else {
      stryCov_9fa48("1526");
      if (stryMutAct_9fa48("1529") ? false : stryMutAct_9fa48("1528") ? true : stryMutAct_9fa48("1527") ? input.membership.role.equals(input.role.name) : (stryCov_9fa48("1527", "1528", "1529"), !input.membership.role.equals(input.role.name))) {
        if (stryMutAct_9fa48("1530")) {
          {}
        } else {
          stryCov_9fa48("1530");
          throw new AgentCoreError(stryMutAct_9fa48("1531") ? "" : (stryCov_9fa48("1531"), "protocol.invalid-state"), stryMutAct_9fa48("1532") ? "" : (stryCov_9fa48("1532"), "Membership role and materialized Role must match"));
        }
      }
      if (stryMutAct_9fa48("1535") ? input.membership.subject.kind === "foreign" || input.membership.subject.verifiedVia.value === "handshake" : stryMutAct_9fa48("1534") ? false : stryMutAct_9fa48("1533") ? true : (stryCov_9fa48("1533", "1534", "1535"), (stryMutAct_9fa48("1537") ? input.membership.subject.kind !== "foreign" : stryMutAct_9fa48("1536") ? true : (stryCov_9fa48("1536", "1537"), input.membership.subject.kind === (stryMutAct_9fa48("1538") ? "" : (stryCov_9fa48("1538"), "foreign")))) && (stryMutAct_9fa48("1540") ? input.membership.subject.verifiedVia.value !== "handshake" : stryMutAct_9fa48("1539") ? true : (stryCov_9fa48("1539", "1540"), input.membership.subject.verifiedVia.value === (stryMutAct_9fa48("1541") ? "" : (stryCov_9fa48("1541"), "handshake")))))) {
        if (stryMutAct_9fa48("1542")) {
          {}
        } else {
          stryCov_9fa48("1542");
          throw new AgentCoreError(stryMutAct_9fa48("1543") ? "" : (stryCov_9fa48("1543"), "authority.denied"), stryMutAct_9fa48("1544") ? "" : (stryCov_9fa48("1544"), "Handshake is a guest bootstrap scheme and cannot materialize Grants"));
        }
      }
      const membershipId = input.membership.id;
      const owned = stryMutAct_9fa48("1545") ? input.existing : (stryCov_9fa48("1545"), input.existing.filter(stryMutAct_9fa48("1546") ? () => undefined : (stryCov_9fa48("1546"), grant => stryMutAct_9fa48("1549") ? grant.origin.kind === "role" || grant.origin.membershipId.equals(membershipId) : stryMutAct_9fa48("1548") ? false : stryMutAct_9fa48("1547") ? true : (stryCov_9fa48("1547", "1548", "1549"), (stryMutAct_9fa48("1551") ? grant.origin.kind !== "role" : stryMutAct_9fa48("1550") ? true : (stryCov_9fa48("1550", "1551"), grant.origin.kind === (stryMutAct_9fa48("1552") ? "" : (stryCov_9fa48("1552"), "role")))) && grant.origin.membershipId.equals(membershipId)))));
      if (stryMutAct_9fa48("1555") ? new Set(owned.map(grant => grant.id.value)).size === owned.length : stryMutAct_9fa48("1554") ? false : stryMutAct_9fa48("1553") ? true : (stryCov_9fa48("1553", "1554", "1555"), new Set(owned.map(stryMutAct_9fa48("1556") ? () => undefined : (stryCov_9fa48("1556"), grant => grant.id.value))).size !== owned.length)) {
        if (stryMutAct_9fa48("1557")) {
          {}
        } else {
          stryCov_9fa48("1557");
          throw new AgentCoreError(stryMutAct_9fa48("1558") ? "" : (stryCov_9fa48("1558"), "protocol.invalid-state"), stryMutAct_9fa48("1559") ? "" : (stryCov_9fa48("1559"), "Role materialization input contains duplicate Grant IDs"));
        }
      }
      const desiredActiveRecords = input.membership.isActive ? materializeActive(input.membership, input.role) : stryMutAct_9fa48("1560") ? ["Stryker was here"] : (stryCov_9fa48("1560"), []);
      const ownedById = new Map(owned.map(stryMutAct_9fa48("1561") ? () => undefined : (stryCov_9fa48("1561"), grant => stryMutAct_9fa48("1562") ? [] : (stryCov_9fa48("1562"), [grant.id.value, grant]))));
      const desiredActive = desiredActiveRecords.map(record => {
        if (stryMutAct_9fa48("1563")) {
          {}
        } else {
          stryCov_9fa48("1563");
          const previous = ownedById.get(record.id.value);
          return (stryMutAct_9fa48("1566") ? previous?.isLive !== false : stryMutAct_9fa48("1565") ? false : stryMutAct_9fa48("1564") ? true : (stryCov_9fa48("1564", "1565", "1566"), (stryMutAct_9fa48("1567") ? previous.isLive : (stryCov_9fa48("1567"), previous?.isLive)) === (stryMutAct_9fa48("1568") ? true : (stryCov_9fa48("1568"), false)))) ? record.revoke() : record;
        }
      });
      const activeIds = new Set(desiredActive.map(stryMutAct_9fa48("1569") ? () => undefined : (stryCov_9fa48("1569"), grant => grant.id.value)));
      const obsolete = stryMutAct_9fa48("1570") ? owned.map(grant => grant.revoke()) : (stryCov_9fa48("1570"), owned.filter(stryMutAct_9fa48("1571") ? () => undefined : (stryCov_9fa48("1571"), grant => stryMutAct_9fa48("1572") ? activeIds.has(grant.id.value) : (stryCov_9fa48("1572"), !activeIds.has(grant.id.value)))).map(stryMutAct_9fa48("1573") ? () => undefined : (stryCov_9fa48("1573"), grant => grant.revoke())));
      const desiredRecords = stryMutAct_9fa48("1574") ? [] : (stryCov_9fa48("1574"), [...desiredActive, ...obsolete]);
      const previousById = new Map(owned.map(stryMutAct_9fa48("1575") ? () => undefined : (stryCov_9fa48("1575"), grant => stryMutAct_9fa48("1576") ? [] : (stryCov_9fa48("1576"), [grant.id.value, grant]))));
      const changedRecords = stryMutAct_9fa48("1577") ? desiredRecords : (stryCov_9fa48("1577"), desiredRecords.filter(record => {
        if (stryMutAct_9fa48("1578")) {
          {}
        } else {
          stryCov_9fa48("1578");
          const previous = previousById.get(record.id.value);
          return stryMutAct_9fa48("1581") ? previous === undefined && !bytesEqual(Grant.encode(previous), Grant.encode(record)) : stryMutAct_9fa48("1580") ? false : stryMutAct_9fa48("1579") ? true : (stryCov_9fa48("1579", "1580", "1581"), (stryMutAct_9fa48("1583") ? previous !== undefined : stryMutAct_9fa48("1582") ? false : (stryCov_9fa48("1582", "1583"), previous === undefined)) || (stryMutAct_9fa48("1584") ? bytesEqual(Grant.encode(previous), Grant.encode(record)) : (stryCov_9fa48("1584"), !bytesEqual(Grant.encode(previous), Grant.encode(record)))));
        }
      }));
      const affected = new Map<string, ScopeRef>();
      for (const changed of changedRecords) affected.set(scopeKey(changed.scope), changed.scope);
      return new RoleGrantMaterialization(desiredRecords, changedRecords, stryMutAct_9fa48("1585") ? [] : (stryCov_9fa48("1585"), [...affected.values()]));
    }
  }
}
function materializeActive(membership: Membership, role: Role): readonly Grant[] {
  if (stryMutAct_9fa48("1586")) {
    {}
  } else {
    stryCov_9fa48("1586");
    const guest = stryMutAct_9fa48("1589") ? membership.subject.kind !== "foreign" : stryMutAct_9fa48("1588") ? false : stryMutAct_9fa48("1587") ? true : (stryCov_9fa48("1587", "1588", "1589"), membership.subject.kind === (stryMutAct_9fa48("1590") ? "" : (stryCov_9fa48("1590"), "foreign")));
    if (stryMutAct_9fa48("1593") ? guest || membership.guestVerification === undefined : stryMutAct_9fa48("1592") ? false : stryMutAct_9fa48("1591") ? true : (stryCov_9fa48("1591", "1592", "1593"), guest && (stryMutAct_9fa48("1595") ? membership.guestVerification !== undefined : stryMutAct_9fa48("1594") ? true : (stryCov_9fa48("1594", "1595"), membership.guestVerification === undefined)))) return stryMutAct_9fa48("1596") ? ["Stryker was here"] : (stryCov_9fa48("1596"), []);
    const records: Grant[] = stryMutAct_9fa48("1597") ? ["Stryker was here"] : (stryCov_9fa48("1597"), []);
    role.rules.forEach((rule, ruleOrdinal) => {
      if (stryMutAct_9fa48("1598")) {
        {}
      } else {
        stryCov_9fa48("1598");
        const capability = roleCapability(rule);
        if (stryMutAct_9fa48("1601") ? guest && rule.effect === "allow" || capability.grantsElevation() : stryMutAct_9fa48("1600") ? false : stryMutAct_9fa48("1599") ? true : (stryCov_9fa48("1599", "1600", "1601"), (stryMutAct_9fa48("1603") ? guest || rule.effect === "allow" : stryMutAct_9fa48("1602") ? true : (stryCov_9fa48("1602", "1603"), guest && (stryMutAct_9fa48("1605") ? rule.effect !== "allow" : stryMutAct_9fa48("1604") ? true : (stryCov_9fa48("1604", "1605"), rule.effect === (stryMutAct_9fa48("1606") ? "" : (stryCov_9fa48("1606"), "allow")))))) && capability.grantsElevation())) return;
        records.push(new Grant(GrantId.forRole(membership.id, ruleOrdinal), membership.scope, membership.subject, rule.effect, capability, stryMutAct_9fa48("1607") ? {} : (stryCov_9fa48("1607"), {
          kind: stryMutAct_9fa48("1608") ? "" : (stryCov_9fa48("1608"), "role"),
          membershipId: membership.id,
          roleName: role.name.value,
          ruleOrdinal,
          guest
        })));
      }
    });
    return records;
  }
}
function roleCapability(rule: RoleRule): CapabilitySpec {
  if (stryMutAct_9fa48("1609")) {
    {}
  } else {
    stryCov_9fa48("1609");
    return rule.capability;
  }
}
function canonicalGrants(grants: readonly Grant[]): readonly Grant[] {
  if (stryMutAct_9fa48("1610")) {
    {}
  } else {
    stryCov_9fa48("1610");
    const ordered = stryMutAct_9fa48("1611") ? [...grants] : (stryCov_9fa48("1611"), (stryMutAct_9fa48("1612") ? [] : (stryCov_9fa48("1612"), [...grants])).sort(stryMutAct_9fa48("1613") ? () => undefined : (stryCov_9fa48("1613"), (left, right) => left.id.value.localeCompare(right.id.value))));
    if (stryMutAct_9fa48("1616") ? new Set(ordered.map(grant => grant.id.value)).size === ordered.length : stryMutAct_9fa48("1615") ? false : stryMutAct_9fa48("1614") ? true : (stryCov_9fa48("1614", "1615", "1616"), new Set(ordered.map(stryMutAct_9fa48("1617") ? () => undefined : (stryCov_9fa48("1617"), grant => grant.id.value))).size !== ordered.length)) {
      if (stryMutAct_9fa48("1618")) {
        {}
      } else {
        stryCov_9fa48("1618");
        throw new AgentCoreError(stryMutAct_9fa48("1619") ? "" : (stryCov_9fa48("1619"), "protocol.invalid-state"), stryMutAct_9fa48("1620") ? "" : (stryCov_9fa48("1620"), "Role materialization output Grant IDs must be unique"));
      }
    }
    return Object.freeze(ordered);
  }
}