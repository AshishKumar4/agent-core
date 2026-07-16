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
import { Revision } from "../core";
import { AgentCoreError } from "../errors";
import { Membership, MembershipId, MemoryIdentityRepository, GuestTrust, GuestTrustId, Principal, PrincipalId, Project, ProjectId, Role, RoleName, Team, TeamId, Tenant, TenantId, WorkspaceId, Workspace, type IdentityRecordKind, type MemoryIdentitySnapshot, type StoredIdentityRecord, type TenantKind } from "../identity";
import { bytesEqual } from "./data";
import { ScopeEpoch } from "./epoch";
import { Grant } from "./grant";
import type { GrantId } from "./id";
import { RoleGrantMaterializer } from "./materializer";
import { scopeKey } from "./reference";
import { createTenantControlBootstrapPlan, type AuthorityMutationStore, type TenantControlBootstrapAnchor, type TenantControlBootstrapPlan } from "./service";
export type { TenantControlBootstrapAnchor } from "./service";
const SNAPSHOT_VERSION = 1 as const;
export interface StoredTenantControlRecord {
  readonly id: string;
  readonly bytes: Uint8Array;
}
export interface MemoryTenantControlAnchorSnapshot {
  readonly actorId: ActorId;
  readonly tenantId: TenantId;
  readonly principalId: PrincipalId;
  readonly tenantKind: TenantKind;
  readonly trustAnchor: Uint8Array;
}
export interface MemoryTenantControlMarkerSnapshot {
  readonly tenantId: TenantId;
  readonly ownerPrincipalId: PrincipalId;
  readonly revision: number;
}
export interface MemoryTenantControlSnapshot {
  readonly version: 1;
  readonly anchor: MemoryTenantControlAnchorSnapshot;
  readonly marker: MemoryTenantControlMarkerSnapshot | null;
  readonly identity: MemoryIdentitySnapshot;
  readonly grants: readonly StoredTenantControlRecord[];
  readonly epochs: readonly StoredTenantControlRecord[];
}
export interface TenantControlBootstrapMarker {
  readonly tenantId: TenantId;
  readonly ownerPrincipalId: PrincipalId;
  readonly revision: Revision;
}
type RecordMap = Map<string, Uint8Array>;
type WriteMode = "bootstrap" | "mutation";

/** Actor-local reference store. It is intentionally absent from the authority package surface. */
export class MemoryTenantControlStore implements AuthorityMutationStore {
  #identity: Map<string, StoredIdentityRecord>;
  #grants: RecordMap;
  #epochs: RecordMap;
  readonly #anchor: MemoryTenantControlAnchorSnapshot;
  #marker: MemoryTenantControlMarkerSnapshot | null;
  #writeMode: WriteMode | undefined;
  #transactionActive = stryMutAct_9fa48("1621") ? true : (stryCov_9fa48("1621"), false);
  public readonly tenantId: TenantId;
  private constructor(snapshot: MemoryTenantControlSnapshot) {
    if (stryMutAct_9fa48("1622")) {
      {}
    } else {
      stryCov_9fa48("1622");
      requireSnapshot(snapshot);
      this.#anchor = copyAnchorSnapshot(snapshot.anchor);
      this.tenantId = this.#anchor.tenantId;
      this.#marker = (stryMutAct_9fa48("1625") ? snapshot.marker !== null : stryMutAct_9fa48("1624") ? false : stryMutAct_9fa48("1623") ? true : (stryCov_9fa48("1623", "1624", "1625"), snapshot.marker === null)) ? null : copyMarkerSnapshot(snapshot.marker);
      const identity = new MemoryIdentityRepository(snapshot.identity).snapshot();
      this.#identity = new Map(identity.records.map(stryMutAct_9fa48("1626") ? () => undefined : (stryCov_9fa48("1626"), record => stryMutAct_9fa48("1627") ? [] : (stryCov_9fa48("1627"), [identityKey(record.kind, record.id), copyIdentityRecord(record)]))));
      this.#grants = loadRecords(snapshot.grants, Grant.decode, stryMutAct_9fa48("1628") ? () => undefined : (stryCov_9fa48("1628"), record => record.id.value), stryMutAct_9fa48("1629") ? "" : (stryCov_9fa48("1629"), "Grant"));
      this.#epochs = loadRecords(snapshot.epochs, ScopeEpoch.decode, stryMutAct_9fa48("1630") ? () => undefined : (stryCov_9fa48("1630"), record => scopeKey(record.scope)), stryMutAct_9fa48("1631") ? "" : (stryCov_9fa48("1631"), "Scope epoch"));
      this.assertRestoredState();
    }
  }
  public static create(anchor: TenantControlBootstrapAnchor): MemoryTenantControlStore {
    if (stryMutAct_9fa48("1632")) {
      {}
    } else {
      stryCov_9fa48("1632");
      return new MemoryTenantControlStore(Object.freeze(stryMutAct_9fa48("1633") ? {} : (stryCov_9fa48("1633"), {
        version: SNAPSHOT_VERSION,
        anchor: anchorSnapshot(anchor),
        marker: null,
        identity: Object.freeze(stryMutAct_9fa48("1634") ? {} : (stryCov_9fa48("1634"), {
          version: SNAPSHOT_VERSION,
          records: Object.freeze(stryMutAct_9fa48("1635") ? ["Stryker was here"] : (stryCov_9fa48("1635"), []))
        })),
        grants: Object.freeze(stryMutAct_9fa48("1636") ? ["Stryker was here"] : (stryCov_9fa48("1636"), [])),
        epochs: Object.freeze(stryMutAct_9fa48("1637") ? ["Stryker was here"] : (stryCov_9fa48("1637"), []))
      })));
    }
  }
  public static restore(snapshot: MemoryTenantControlSnapshot): MemoryTenantControlStore {
    if (stryMutAct_9fa48("1638")) {
      {}
    } else {
      stryCov_9fa48("1638");
      return new MemoryTenantControlStore(snapshot);
    }
  }
  public bootstrapAnchor(): TenantControlBootstrapAnchor {
    if (stryMutAct_9fa48("1639")) {
      {}
    } else {
      stryCov_9fa48("1639");
      return Object.freeze(stryMutAct_9fa48("1640") ? {} : (stryCov_9fa48("1640"), {
        actorId: this.#anchor.actorId,
        tenantId: this.#anchor.tenantId,
        principalId: this.#anchor.principalId,
        tenantKind: this.#anchor.tenantKind,
        trustAnchor: stryMutAct_9fa48("1641") ? this.#anchor.trustAnchor : (stryCov_9fa48("1641"), this.#anchor.trustAnchor.slice())
      }));
    }
  }
  public bootstrapMarker(): TenantControlBootstrapMarker | undefined {
    if (stryMutAct_9fa48("1642")) {
      {}
    } else {
      stryCov_9fa48("1642");
      if (stryMutAct_9fa48("1645") ? this.#marker !== null : stryMutAct_9fa48("1644") ? false : stryMutAct_9fa48("1643") ? true : (stryCov_9fa48("1643", "1644", "1645"), this.#marker === null)) return undefined;
      return Object.freeze(stryMutAct_9fa48("1646") ? {} : (stryCov_9fa48("1646"), {
        tenantId: this.#marker.tenantId,
        ownerPrincipalId: this.#marker.ownerPrincipalId,
        revision: new Revision(this.#marker.revision)
      }));
    }
  }
  public isBootstrapEligible(): boolean {
    if (stryMutAct_9fa48("1647")) {
      {}
    } else {
      stryCov_9fa48("1647");
      return stryMutAct_9fa48("1650") ? this.#marker === null && this.#identity.size === 0 && this.#grants.size === 0 || this.#epochs.size === 0 : stryMutAct_9fa48("1649") ? false : stryMutAct_9fa48("1648") ? true : (stryCov_9fa48("1648", "1649", "1650"), (stryMutAct_9fa48("1652") ? this.#marker === null && this.#identity.size === 0 || this.#grants.size === 0 : stryMutAct_9fa48("1651") ? true : (stryCov_9fa48("1651", "1652"), (stryMutAct_9fa48("1654") ? this.#marker === null || this.#identity.size === 0 : stryMutAct_9fa48("1653") ? true : (stryCov_9fa48("1653", "1654"), (stryMutAct_9fa48("1656") ? this.#marker !== null : stryMutAct_9fa48("1655") ? true : (stryCov_9fa48("1655", "1656"), this.#marker === null)) && (stryMutAct_9fa48("1658") ? this.#identity.size !== 0 : stryMutAct_9fa48("1657") ? true : (stryCov_9fa48("1657", "1658"), this.#identity.size === 0)))) && (stryMutAct_9fa48("1660") ? this.#grants.size !== 0 : stryMutAct_9fa48("1659") ? true : (stryCov_9fa48("1659", "1660"), this.#grants.size === 0)))) && (stryMutAct_9fa48("1662") ? this.#epochs.size !== 0 : stryMutAct_9fa48("1661") ? true : (stryCov_9fa48("1661", "1662"), this.#epochs.size === 0)));
    }
  }
  public bootstrap(plan: TenantControlBootstrapPlan): void {
    if (stryMutAct_9fa48("1663")) {
      {}
    } else {
      stryCov_9fa48("1663");
      if (stryMutAct_9fa48("1666") ? false : stryMutAct_9fa48("1665") ? true : stryMutAct_9fa48("1664") ? this.isBootstrapEligible() : (stryCov_9fa48("1664", "1665", "1666"), !this.isBootstrapEligible())) {
        if (stryMutAct_9fa48("1667")) {
          {}
        } else {
          stryCov_9fa48("1667");
          throw new AgentCoreError(stryMutAct_9fa48("1668") ? "" : (stryCov_9fa48("1668"), "protocol.invalid-state"), stryMutAct_9fa48("1669") ? "" : (stryCov_9fa48("1669"), "Tenant control is not bootstrap eligible"));
        }
      }
      this.commit(stryMutAct_9fa48("1670") ? "" : (stryCov_9fa48("1670"), "bootstrap"), stryMutAct_9fa48("1671") ? () => undefined : (stryCov_9fa48("1671"), candidate => candidate.applyBootstrap(plan)));
    }
  }
  public bootstrapTenant(anchor: TenantControlBootstrapAnchor, expectedRevision: Revision): void {
    if (stryMutAct_9fa48("1672")) {
      {}
    } else {
      stryCov_9fa48("1672");
      if (stryMutAct_9fa48("1675") ? false : stryMutAct_9fa48("1674") ? true : stryMutAct_9fa48("1673") ? anchorsEqual(this.bootstrapAnchor(), anchor) : (stryCov_9fa48("1673", "1674", "1675"), !anchorsEqual(this.bootstrapAnchor(), anchor))) {
        if (stryMutAct_9fa48("1676")) {
          {}
        } else {
          stryCov_9fa48("1676");
          throw new AgentCoreError(stryMutAct_9fa48("1677") ? "" : (stryCov_9fa48("1677"), "protocol.invalid-state"), stryMutAct_9fa48("1678") ? "" : (stryCov_9fa48("1678"), "Tenant bootstrap request does not match its immutable anchor"));
        }
      }
      this.bootstrap(createTenantControlBootstrapPlan(anchor, expectedRevision));
    }
  }
  public transaction<Result>(operation: (store: AuthorityMutationStore) => Result): Result {
    if (stryMutAct_9fa48("1679")) {
      {}
    } else {
      stryCov_9fa48("1679");
      if (stryMutAct_9fa48("1682") ? this.#marker !== null : stryMutAct_9fa48("1681") ? false : stryMutAct_9fa48("1680") ? true : (stryCov_9fa48("1680", "1681", "1682"), this.#marker === null)) {
        if (stryMutAct_9fa48("1683")) {
          {}
        } else {
          stryCov_9fa48("1683");
          throw new AgentCoreError(stryMutAct_9fa48("1684") ? "" : (stryCov_9fa48("1684"), "protocol.invalid-state"), stryMutAct_9fa48("1685") ? "" : (stryCov_9fa48("1685"), "Tenant authority mutations require completed bootstrap"));
        }
      }
      return this.commit(stryMutAct_9fa48("1686") ? "" : (stryCov_9fa48("1686"), "mutation"), operation);
    }
  }
  public snapshot(): MemoryTenantControlSnapshot {
    if (stryMutAct_9fa48("1687")) {
      {}
    } else {
      stryCov_9fa48("1687");
      return Object.freeze(stryMutAct_9fa48("1688") ? {} : (stryCov_9fa48("1688"), {
        version: SNAPSHOT_VERSION,
        anchor: copyAnchorSnapshot(this.#anchor),
        marker: (stryMutAct_9fa48("1691") ? this.#marker !== null : stryMutAct_9fa48("1690") ? false : stryMutAct_9fa48("1689") ? true : (stryCov_9fa48("1689", "1690", "1691"), this.#marker === null)) ? null : copyMarkerSnapshot(this.#marker),
        identity: this.identitySnapshot(),
        grants: snapshotRecords(this.#grants),
        epochs: snapshotRecords(this.#epochs)
      }));
    }
  }
  public identitySnapshot(): MemoryIdentitySnapshot {
    if (stryMutAct_9fa48("1692")) {
      {}
    } else {
      stryCov_9fa48("1692");
      return Object.freeze(stryMutAct_9fa48("1693") ? {} : (stryCov_9fa48("1693"), {
        version: SNAPSHOT_VERSION,
        records: Object.freeze(stryMutAct_9fa48("1694") ? [...this.#identity.values()].map(copyIdentityRecord) : (stryCov_9fa48("1694"), (stryMutAct_9fa48("1695") ? [] : (stryCov_9fa48("1695"), [...this.#identity.values()])).sort(stryMutAct_9fa48("1696") ? () => undefined : (stryCov_9fa48("1696"), (left, right) => identityKey(left.kind, left.id).localeCompare(identityKey(right.kind, right.id)))).map(copyIdentityRecord)))
      }));
    }
  }
  public tenant(id: TenantId): Tenant | undefined {
    if (stryMutAct_9fa48("1697")) {
      {}
    } else {
      stryCov_9fa48("1697");
      return this.identityRecord(stryMutAct_9fa48("1698") ? "" : (stryCov_9fa48("1698"), "tenant"), id.value, Tenant.decode);
    }
  }
  public principal(id: PrincipalId): Principal | undefined {
    if (stryMutAct_9fa48("1699")) {
      {}
    } else {
      stryCov_9fa48("1699");
      return this.identityRecord(stryMutAct_9fa48("1700") ? "" : (stryCov_9fa48("1700"), "principal"), id.value, Principal.decode);
    }
  }
  public team(id: TeamId): Team | undefined {
    if (stryMutAct_9fa48("1701")) {
      {}
    } else {
      stryCov_9fa48("1701");
      return this.identityRecord(stryMutAct_9fa48("1702") ? "" : (stryCov_9fa48("1702"), "team"), id.value, Team.decode);
    }
  }
  public teams(): readonly Team[] {
    if (stryMutAct_9fa48("1703")) {
      {}
    } else {
      stryCov_9fa48("1703");
      return this.identityRecords(stryMutAct_9fa48("1704") ? "" : (stryCov_9fa48("1704"), "team"), Team.decode);
    }
  }
  public project(id: ProjectId): Project | undefined {
    if (stryMutAct_9fa48("1705")) {
      {}
    } else {
      stryCov_9fa48("1705");
      return this.identityRecord(stryMutAct_9fa48("1706") ? "" : (stryCov_9fa48("1706"), "project"), id.value, Project.decode);
    }
  }
  public putProject(project: Project): void {
    if (stryMutAct_9fa48("1707")) {
      {}
    } else {
      stryCov_9fa48("1707");
      this.requireWrite();
      if (stryMutAct_9fa48("1710") ? false : stryMutAct_9fa48("1709") ? true : stryMutAct_9fa48("1708") ? project.tenantId.equals(this.tenantId) : (stryCov_9fa48("1708", "1709", "1710"), !project.tenantId.equals(this.tenantId))) {
        if (stryMutAct_9fa48("1711")) {
          {}
        } else {
          stryCov_9fa48("1711");
          throw new AgentCoreError(stryMutAct_9fa48("1712") ? "" : (stryCov_9fa48("1712"), "protocol.invalid-state"), stryMutAct_9fa48("1713") ? "" : (stryCov_9fa48("1713"), "Project belongs to another Tenant"));
        }
      }
      const previous = this.project(project.id);
      if (stryMutAct_9fa48("1716") ? previous !== undefined : stryMutAct_9fa48("1715") ? false : stryMutAct_9fa48("1714") ? true : (stryCov_9fa48("1714", "1715", "1716"), previous === undefined)) {
        if (stryMutAct_9fa48("1717")) {
          {}
        } else {
          stryCov_9fa48("1717");
          if (stryMutAct_9fa48("1720") ? project.revision.value === 0 : stryMutAct_9fa48("1719") ? false : stryMutAct_9fa48("1718") ? true : (stryCov_9fa48("1718", "1719", "1720"), project.revision.value !== 0)) {
            if (stryMutAct_9fa48("1721")) {
              {}
            } else {
              stryCov_9fa48("1721");
              throw new AgentCoreError(stryMutAct_9fa48("1722") ? "" : (stryCov_9fa48("1722"), "protocol.invalid-state"), stryMutAct_9fa48("1723") ? "" : (stryCov_9fa48("1723"), "New Projects require revision zero"));
            }
          }
        }
      } else if (stryMutAct_9fa48("1726") ? project.revision.value === previous.revision.value + 1 : stryMutAct_9fa48("1725") ? false : stryMutAct_9fa48("1724") ? true : (stryCov_9fa48("1724", "1725", "1726"), project.revision.value !== (stryMutAct_9fa48("1727") ? previous.revision.value - 1 : (stryCov_9fa48("1727"), previous.revision.value + 1)))) {
        if (stryMutAct_9fa48("1728")) {
          {}
        } else {
          stryCov_9fa48("1728");
          throw new AgentCoreError(stryMutAct_9fa48("1729") ? "" : (stryCov_9fa48("1729"), "protocol.revision-conflict"), stryMutAct_9fa48("1730") ? "" : (stryCov_9fa48("1730"), "Project updates require the next revision"));
        }
      }
      this.putIdentity(stryMutAct_9fa48("1731") ? "" : (stryCov_9fa48("1731"), "project"), project.id.value, Project.encode(project));
    }
  }
  public workspace(id: WorkspaceId): Workspace | undefined {
    if (stryMutAct_9fa48("1732")) {
      {}
    } else {
      stryCov_9fa48("1732");
      return this.identityRecord(stryMutAct_9fa48("1733") ? "" : (stryCov_9fa48("1733"), "workspace"), id.value, Workspace.decode);
    }
  }
  public putWorkspace(workspace: Workspace): void {
    if (stryMutAct_9fa48("1734")) {
      {}
    } else {
      stryCov_9fa48("1734");
      this.requireWrite();
      if (stryMutAct_9fa48("1737") ? false : stryMutAct_9fa48("1736") ? true : stryMutAct_9fa48("1735") ? workspace.tenantId.equals(this.tenantId) : (stryCov_9fa48("1735", "1736", "1737"), !workspace.tenantId.equals(this.tenantId))) {
        if (stryMutAct_9fa48("1738")) {
          {}
        } else {
          stryCov_9fa48("1738");
          throw new AgentCoreError(stryMutAct_9fa48("1739") ? "" : (stryCov_9fa48("1739"), "protocol.invalid-state"), stryMutAct_9fa48("1740") ? "" : (stryCov_9fa48("1740"), "Workspace belongs to another Tenant"));
        }
      }
      const previous = this.workspace(workspace.id);
      if (stryMutAct_9fa48("1743") ? previous === undefined : stryMutAct_9fa48("1742") ? false : stryMutAct_9fa48("1741") ? true : (stryCov_9fa48("1741", "1742", "1743"), previous !== undefined)) {
        if (stryMutAct_9fa48("1744")) {
          {}
        } else {
          stryCov_9fa48("1744");
          throw new AgentCoreError(stryMutAct_9fa48("1745") ? "" : (stryCov_9fa48("1745"), "protocol.invalid-state"), stryMutAct_9fa48("1746") ? "" : (stryCov_9fa48("1746"), "Workspace topology is immutable"));
        }
      }
      if (stryMutAct_9fa48("1749") ? workspace.revision.value === 0 : stryMutAct_9fa48("1748") ? false : stryMutAct_9fa48("1747") ? true : (stryCov_9fa48("1747", "1748", "1749"), workspace.revision.value !== 0)) {
        if (stryMutAct_9fa48("1750")) {
          {}
        } else {
          stryCov_9fa48("1750");
          throw new AgentCoreError(stryMutAct_9fa48("1751") ? "" : (stryCov_9fa48("1751"), "protocol.invalid-state"), stryMutAct_9fa48("1752") ? "" : (stryCov_9fa48("1752"), "New Workspaces require revision zero"));
        }
      }
      this.putIdentity(stryMutAct_9fa48("1753") ? "" : (stryCov_9fa48("1753"), "workspace"), workspace.id.value, Workspace.encode(workspace));
    }
  }
  public guestTrust(id: GuestTrustId): GuestTrust | undefined {
    if (stryMutAct_9fa48("1754")) {
      {}
    } else {
      stryCov_9fa48("1754");
      return this.identityRecord(stryMutAct_9fa48("1755") ? "" : (stryCov_9fa48("1755"), "guestTrust"), id.value, GuestTrust.decode);
    }
  }
  public guestTrusts(): readonly GuestTrust[] {
    if (stryMutAct_9fa48("1756")) {
      {}
    } else {
      stryCov_9fa48("1756");
      return this.identityRecords(stryMutAct_9fa48("1757") ? "" : (stryCov_9fa48("1757"), "guestTrust"), GuestTrust.decode);
    }
  }
  public putGuestTrust(trust: GuestTrust): void {
    if (stryMutAct_9fa48("1758")) {
      {}
    } else {
      stryCov_9fa48("1758");
      this.requireWrite();
      if (stryMutAct_9fa48("1761") ? false : stryMutAct_9fa48("1760") ? true : stryMutAct_9fa48("1759") ? trust.hostTenant.equals(this.tenantId) : (stryCov_9fa48("1759", "1760", "1761"), !trust.hostTenant.equals(this.tenantId))) {
        if (stryMutAct_9fa48("1762")) {
          {}
        } else {
          stryCov_9fa48("1762");
          throw new AgentCoreError(stryMutAct_9fa48("1763") ? "" : (stryCov_9fa48("1763"), "protocol.invalid-state"), stryMutAct_9fa48("1764") ? "" : (stryCov_9fa48("1764"), "Guest trust belongs to another Tenant"));
        }
      }
      const previous = this.guestTrust(trust.id);
      if (stryMutAct_9fa48("1767") ? previous !== undefined : stryMutAct_9fa48("1766") ? false : stryMutAct_9fa48("1765") ? true : (stryCov_9fa48("1765", "1766", "1767"), previous === undefined)) {
        if (stryMutAct_9fa48("1768")) {
          {}
        } else {
          stryCov_9fa48("1768");
          if (stryMutAct_9fa48("1771") ? trust.revision.value !== 0 && !trust.isActive : stryMutAct_9fa48("1770") ? false : stryMutAct_9fa48("1769") ? true : (stryCov_9fa48("1769", "1770", "1771"), (stryMutAct_9fa48("1773") ? trust.revision.value === 0 : stryMutAct_9fa48("1772") ? false : (stryCov_9fa48("1772", "1773"), trust.revision.value !== 0)) || (stryMutAct_9fa48("1774") ? trust.isActive : (stryCov_9fa48("1774"), !trust.isActive)))) {
            if (stryMutAct_9fa48("1775")) {
              {}
            } else {
              stryCov_9fa48("1775");
              throw new AgentCoreError(stryMutAct_9fa48("1776") ? "" : (stryCov_9fa48("1776"), "protocol.invalid-state"), stryMutAct_9fa48("1777") ? "" : (stryCov_9fa48("1777"), "New guest trust requires revision zero and active state"));
            }
          }
        }
      } else if (stryMutAct_9fa48("1780") ? !previous.hostTenant.equals(trust.hostTenant) && !previous.homeTenant.equals(trust.homeTenant) : stryMutAct_9fa48("1779") ? false : stryMutAct_9fa48("1778") ? true : (stryCov_9fa48("1778", "1779", "1780"), (stryMutAct_9fa48("1781") ? previous.hostTenant.equals(trust.hostTenant) : (stryCov_9fa48("1781"), !previous.hostTenant.equals(trust.hostTenant))) || (stryMutAct_9fa48("1782") ? previous.homeTenant.equals(trust.homeTenant) : (stryCov_9fa48("1782"), !previous.homeTenant.equals(trust.homeTenant))))) {
        if (stryMutAct_9fa48("1783")) {
          {}
        } else {
          stryCov_9fa48("1783");
          throw new AgentCoreError(stryMutAct_9fa48("1784") ? "" : (stryCov_9fa48("1784"), "protocol.revision-conflict"), stryMutAct_9fa48("1785") ? "" : (stryCov_9fa48("1785"), "Guest trust identity changed"));
        }
      } else {
        if (stryMutAct_9fa48("1786")) {
          {}
        } else {
          stryCov_9fa48("1786");
          if (stryMutAct_9fa48("1788") ? false : stryMutAct_9fa48("1787") ? true : (stryCov_9fa48("1787", "1788"), bytesEqual(GuestTrust.encode(previous), GuestTrust.encode(trust)))) return;
          previous.assertCanReplace(trust);
        }
      }
      this.putIdentity(stryMutAct_9fa48("1789") ? "" : (stryCov_9fa48("1789"), "guestTrust"), trust.id.value, GuestTrust.encode(trust));
    }
  }
  public role(name: RoleName): Role | undefined {
    if (stryMutAct_9fa48("1790")) {
      {}
    } else {
      stryCov_9fa48("1790");
      return this.identityRecord(stryMutAct_9fa48("1791") ? "" : (stryCov_9fa48("1791"), "role"), name.value, Role.decode);
    }
  }
  public roles(): readonly Role[] {
    if (stryMutAct_9fa48("1792")) {
      {}
    } else {
      stryCov_9fa48("1792");
      return this.identityRecords(stryMutAct_9fa48("1793") ? "" : (stryCov_9fa48("1793"), "role"), Role.decode);
    }
  }
  public membership(id: MembershipId): Membership | undefined {
    if (stryMutAct_9fa48("1794")) {
      {}
    } else {
      stryCov_9fa48("1794");
      return this.identityRecord(stryMutAct_9fa48("1795") ? "" : (stryCov_9fa48("1795"), "membership"), id.value, Membership.decode);
    }
  }
  public memberships(): readonly Membership[] {
    if (stryMutAct_9fa48("1796")) {
      {}
    } else {
      stryCov_9fa48("1796");
      return this.identityRecords(stryMutAct_9fa48("1797") ? "" : (stryCov_9fa48("1797"), "membership"), Membership.decode);
    }
  }
  public grant(id: GrantId): Grant | undefined {
    if (stryMutAct_9fa48("1798")) {
      {}
    } else {
      stryCov_9fa48("1798");
      return decodeRecord(this.#grants, id.value, Grant.decode, stryMutAct_9fa48("1799") ? () => undefined : (stryCov_9fa48("1799"), record => record.id.value), stryMutAct_9fa48("1800") ? "" : (stryCov_9fa48("1800"), "Grant"));
    }
  }
  public grants(): readonly Grant[] {
    if (stryMutAct_9fa48("1801")) {
      {}
    } else {
      stryCov_9fa48("1801");
      return decodeRecords(this.#grants, Grant.decode, stryMutAct_9fa48("1802") ? () => undefined : (stryCov_9fa48("1802"), record => record.id.value), stryMutAct_9fa48("1803") ? "" : (stryCov_9fa48("1803"), "Grant"));
    }
  }
  public epoch(scope: ScopeEpoch["scope"]): ScopeEpoch {
    if (stryMutAct_9fa48("1804")) {
      {}
    } else {
      stryCov_9fa48("1804");
      return stryMutAct_9fa48("1805") ? decodeRecord(this.#epochs, scopeKey(scope), ScopeEpoch.decode, record => scopeKey(record.scope), "Scope epoch") && ScopeEpoch.initial(scope) : (stryCov_9fa48("1805"), decodeRecord(this.#epochs, scopeKey(scope), ScopeEpoch.decode, stryMutAct_9fa48("1806") ? () => undefined : (stryCov_9fa48("1806"), record => scopeKey(record.scope)), stryMutAct_9fa48("1807") ? "" : (stryCov_9fa48("1807"), "Scope epoch")) ?? ScopeEpoch.initial(scope));
    }
  }
  public epochs(): readonly ScopeEpoch[] {
    if (stryMutAct_9fa48("1808")) {
      {}
    } else {
      stryCov_9fa48("1808");
      return decodeRecords(this.#epochs, ScopeEpoch.decode, stryMutAct_9fa48("1809") ? () => undefined : (stryCov_9fa48("1809"), record => scopeKey(record.scope)), stryMutAct_9fa48("1810") ? "" : (stryCov_9fa48("1810"), "Scope epoch"));
    }
  }
  public putPrincipal(principal: Principal): void {
    if (stryMutAct_9fa48("1811")) {
      {}
    } else {
      stryCov_9fa48("1811");
      this.requireWrite();
      const previous = this.principal(principal.id);
      if (stryMutAct_9fa48("1814") ? previous === undefined : stryMutAct_9fa48("1813") ? false : stryMutAct_9fa48("1812") ? true : (stryCov_9fa48("1812", "1813", "1814"), previous !== undefined)) {
        if (stryMutAct_9fa48("1815")) {
          {}
        } else {
          stryCov_9fa48("1815");
          if (stryMutAct_9fa48("1818") ? previous.kind === principal.kind : stryMutAct_9fa48("1817") ? false : stryMutAct_9fa48("1816") ? true : (stryCov_9fa48("1816", "1817", "1818"), previous.kind !== principal.kind)) {
            if (stryMutAct_9fa48("1819")) {
              {}
            } else {
              stryCov_9fa48("1819");
              throw new AgentCoreError(stryMutAct_9fa48("1820") ? "" : (stryCov_9fa48("1820"), "protocol.invalid-state"), stryMutAct_9fa48("1821") ? "" : (stryCov_9fa48("1821"), "Principal kind is immutable"));
            }
          }
          if (stryMutAct_9fa48("1824") ? previous.status === "disabled" || principal.status !== "disabled" : stryMutAct_9fa48("1823") ? false : stryMutAct_9fa48("1822") ? true : (stryCov_9fa48("1822", "1823", "1824"), (stryMutAct_9fa48("1826") ? previous.status !== "disabled" : stryMutAct_9fa48("1825") ? true : (stryCov_9fa48("1825", "1826"), previous.status === (stryMutAct_9fa48("1827") ? "" : (stryCov_9fa48("1827"), "disabled")))) && (stryMutAct_9fa48("1829") ? principal.status === "disabled" : stryMutAct_9fa48("1828") ? true : (stryCov_9fa48("1828", "1829"), principal.status !== (stryMutAct_9fa48("1830") ? "" : (stryCov_9fa48("1830"), "disabled")))))) {
            if (stryMutAct_9fa48("1831")) {
              {}
            } else {
              stryCov_9fa48("1831");
              throw new AgentCoreError(stryMutAct_9fa48("1832") ? "" : (stryCov_9fa48("1832"), "protocol.invalid-state"), stryMutAct_9fa48("1833") ? "" : (stryCov_9fa48("1833"), "Disabled Principals cannot be reactivated"));
            }
          }
        }
      }
      this.putIdentity(stryMutAct_9fa48("1834") ? "" : (stryCov_9fa48("1834"), "principal"), principal.id.value, Principal.encode(principal));
    }
  }
  public putTeam(team: Team): void {
    if (stryMutAct_9fa48("1835")) {
      {}
    } else {
      stryCov_9fa48("1835");
      this.requireWrite();
      if (stryMutAct_9fa48("1838") ? false : stryMutAct_9fa48("1837") ? true : stryMutAct_9fa48("1836") ? team.tenantId.equals(this.tenantId) : (stryCov_9fa48("1836", "1837", "1838"), !team.tenantId.equals(this.tenantId))) {
        if (stryMutAct_9fa48("1839")) {
          {}
        } else {
          stryCov_9fa48("1839");
          throw new AgentCoreError(stryMutAct_9fa48("1840") ? "" : (stryCov_9fa48("1840"), "protocol.invalid-state"), stryMutAct_9fa48("1841") ? "" : (stryCov_9fa48("1841"), "Team belongs to another Tenant"));
        }
      }
      const previous = this.team(team.id);
      if (stryMutAct_9fa48("1844") ? previous !== undefined : stryMutAct_9fa48("1843") ? false : stryMutAct_9fa48("1842") ? true : (stryCov_9fa48("1842", "1843", "1844"), previous === undefined)) {
        if (stryMutAct_9fa48("1845")) {
          {}
        } else {
          stryCov_9fa48("1845");
          if (stryMutAct_9fa48("1848") ? team.revision.value === 0 : stryMutAct_9fa48("1847") ? false : stryMutAct_9fa48("1846") ? true : (stryCov_9fa48("1846", "1847", "1848"), team.revision.value !== 0)) {
            if (stryMutAct_9fa48("1849")) {
              {}
            } else {
              stryCov_9fa48("1849");
              throw new AgentCoreError(stryMutAct_9fa48("1850") ? "" : (stryCov_9fa48("1850"), "protocol.invalid-state"), stryMutAct_9fa48("1851") ? "" : (stryCov_9fa48("1851"), "New Teams require revision zero"));
            }
          }
        }
      } else if (stryMutAct_9fa48("1854") ? !previous.tenantId.equals(team.tenantId) && team.revision.value !== previous.revision.value + 1 : stryMutAct_9fa48("1853") ? false : stryMutAct_9fa48("1852") ? true : (stryCov_9fa48("1852", "1853", "1854"), (stryMutAct_9fa48("1855") ? previous.tenantId.equals(team.tenantId) : (stryCov_9fa48("1855"), !previous.tenantId.equals(team.tenantId))) || (stryMutAct_9fa48("1857") ? team.revision.value === previous.revision.value + 1 : stryMutAct_9fa48("1856") ? false : (stryCov_9fa48("1856", "1857"), team.revision.value !== (stryMutAct_9fa48("1858") ? previous.revision.value - 1 : (stryCov_9fa48("1858"), previous.revision.value + 1)))))) {
        if (stryMutAct_9fa48("1859")) {
          {}
        } else {
          stryCov_9fa48("1859");
          throw new AgentCoreError(stryMutAct_9fa48("1860") ? "" : (stryCov_9fa48("1860"), "protocol.revision-conflict"), stryMutAct_9fa48("1861") ? "" : (stryCov_9fa48("1861"), "Team updates require the stored Tenant identity and next revision"));
        }
      }
      this.putIdentity(stryMutAct_9fa48("1862") ? "" : (stryCov_9fa48("1862"), "team"), team.id.value, Team.encode(team));
    }
  }
  public putRole(role: Role): void {
    if (stryMutAct_9fa48("1863")) {
      {}
    } else {
      stryCov_9fa48("1863");
      this.requireWrite();
      this.putIdentity(stryMutAct_9fa48("1864") ? "" : (stryCov_9fa48("1864"), "role"), role.name.value, Role.encode(role));
    }
  }
  public putMembership(membership: Membership): void {
    if (stryMutAct_9fa48("1865")) {
      {}
    } else {
      stryCov_9fa48("1865");
      this.requireWrite();
      requireCanonicalScope(this, membership.scope);
      const previous = this.membership(membership.id);
      if (stryMutAct_9fa48("1868") ? previous !== undefined : stryMutAct_9fa48("1867") ? false : stryMutAct_9fa48("1866") ? true : (stryCov_9fa48("1866", "1867", "1868"), previous === undefined)) {
        if (stryMutAct_9fa48("1869")) {
          {}
        } else {
          stryCov_9fa48("1869");
          if (stryMutAct_9fa48("1872") ? membership.revision.value !== 0 && membership.state !== "active" : stryMutAct_9fa48("1871") ? false : stryMutAct_9fa48("1870") ? true : (stryCov_9fa48("1870", "1871", "1872"), (stryMutAct_9fa48("1874") ? membership.revision.value === 0 : stryMutAct_9fa48("1873") ? false : (stryCov_9fa48("1873", "1874"), membership.revision.value !== 0)) || (stryMutAct_9fa48("1876") ? membership.state === "active" : stryMutAct_9fa48("1875") ? false : (stryCov_9fa48("1875", "1876"), membership.state !== (stryMutAct_9fa48("1877") ? "" : (stryCov_9fa48("1877"), "active")))))) {
            if (stryMutAct_9fa48("1878")) {
              {}
            } else {
              stryCov_9fa48("1878");
              throw new AgentCoreError(stryMutAct_9fa48("1879") ? "" : (stryCov_9fa48("1879"), "protocol.invalid-state"), stryMutAct_9fa48("1880") ? "" : (stryCov_9fa48("1880"), "New Memberships must be active at revision zero"));
            }
          }
        }
      } else if (stryMutAct_9fa48("1883") ? (!previous.scope.equals(membership.scope) || !sameSubject(previous, membership)) && membership.revision.value !== previous.revision.value + 1 : stryMutAct_9fa48("1882") ? false : stryMutAct_9fa48("1881") ? true : (stryCov_9fa48("1881", "1882", "1883"), (stryMutAct_9fa48("1885") ? !previous.scope.equals(membership.scope) && !sameSubject(previous, membership) : stryMutAct_9fa48("1884") ? false : (stryCov_9fa48("1884", "1885"), (stryMutAct_9fa48("1886") ? previous.scope.equals(membership.scope) : (stryCov_9fa48("1886"), !previous.scope.equals(membership.scope))) || (stryMutAct_9fa48("1887") ? sameSubject(previous, membership) : (stryCov_9fa48("1887"), !sameSubject(previous, membership))))) || (stryMutAct_9fa48("1889") ? membership.revision.value === previous.revision.value + 1 : stryMutAct_9fa48("1888") ? false : (stryCov_9fa48("1888", "1889"), membership.revision.value !== (stryMutAct_9fa48("1890") ? previous.revision.value - 1 : (stryCov_9fa48("1890"), previous.revision.value + 1)))))) {
        if (stryMutAct_9fa48("1891")) {
          {}
        } else {
          stryCov_9fa48("1891");
          throw new AgentCoreError(stryMutAct_9fa48("1892") ? "" : (stryCov_9fa48("1892"), "protocol.revision-conflict"), stryMutAct_9fa48("1893") ? "" : (stryCov_9fa48("1893"), "Membership subject and Scope are immutable and updates require the next revision"));
        }
      } else if (stryMutAct_9fa48("1896") ? previous.state === "revoked" || membership.state !== "revoked" : stryMutAct_9fa48("1895") ? false : stryMutAct_9fa48("1894") ? true : (stryCov_9fa48("1894", "1895", "1896"), (stryMutAct_9fa48("1898") ? previous.state !== "revoked" : stryMutAct_9fa48("1897") ? true : (stryCov_9fa48("1897", "1898"), previous.state === (stryMutAct_9fa48("1899") ? "" : (stryCov_9fa48("1899"), "revoked")))) && (stryMutAct_9fa48("1901") ? membership.state === "revoked" : stryMutAct_9fa48("1900") ? true : (stryCov_9fa48("1900", "1901"), membership.state !== (stryMutAct_9fa48("1902") ? "" : (stryCov_9fa48("1902"), "revoked")))))) {
        if (stryMutAct_9fa48("1903")) {
          {}
        } else {
          stryCov_9fa48("1903");
          throw new AgentCoreError(stryMutAct_9fa48("1904") ? "" : (stryCov_9fa48("1904"), "protocol.invalid-state"), stryMutAct_9fa48("1905") ? "" : (stryCov_9fa48("1905"), "Revoked Memberships cannot reactivate"));
        }
      } else if (stryMutAct_9fa48("1908") ? previous.state === "suspended" || membership.state === "active" : stryMutAct_9fa48("1907") ? false : stryMutAct_9fa48("1906") ? true : (stryCov_9fa48("1906", "1907", "1908"), (stryMutAct_9fa48("1910") ? previous.state !== "suspended" : stryMutAct_9fa48("1909") ? true : (stryCov_9fa48("1909", "1910"), previous.state === (stryMutAct_9fa48("1911") ? "" : (stryCov_9fa48("1911"), "suspended")))) && (stryMutAct_9fa48("1913") ? membership.state !== "active" : stryMutAct_9fa48("1912") ? true : (stryCov_9fa48("1912", "1913"), membership.state === (stryMutAct_9fa48("1914") ? "" : (stryCov_9fa48("1914"), "active")))))) {
        if (stryMutAct_9fa48("1915")) {
          {}
        } else {
          stryCov_9fa48("1915");
          throw new AgentCoreError(stryMutAct_9fa48("1916") ? "" : (stryCov_9fa48("1916"), "protocol.invalid-state"), stryMutAct_9fa48("1917") ? "" : (stryCov_9fa48("1917"), "Suspended Memberships require replacement rather than reactivation"));
        }
      }
      this.putIdentity(stryMutAct_9fa48("1918") ? "" : (stryCov_9fa48("1918"), "membership"), membership.id.value, Membership.encode(membership));
    }
  }
  public putGrant(record: Grant): void {
    if (stryMutAct_9fa48("1919")) {
      {}
    } else {
      stryCov_9fa48("1919");
      this.requireWrite();
      requireCanonicalScope(this, record.scope);
      const previous = this.grant(record.id);
      if (stryMutAct_9fa48("1922") ? previous === undefined : stryMutAct_9fa48("1921") ? false : stryMutAct_9fa48("1920") ? true : (stryCov_9fa48("1920", "1921", "1922"), previous !== undefined)) {
        if (stryMutAct_9fa48("1923")) {
          {}
        } else {
          stryCov_9fa48("1923");
          if (stryMutAct_9fa48("1925") ? false : stryMutAct_9fa48("1924") ? true : (stryCov_9fa48("1924", "1925"), bytesEqual(Grant.encode(previous), Grant.encode(record)))) return;
          previous.assertCanReplace(record);
        }
      }
      putCanonical(this.#grants, record.id.value, Grant.encode(record), Grant.decode, stryMutAct_9fa48("1926") ? () => undefined : (stryCov_9fa48("1926"), value => value.id.value), stryMutAct_9fa48("1927") ? "" : (stryCov_9fa48("1927"), "Grant"));
    }
  }
  public putEpoch(record: ScopeEpoch): void {
    if (stryMutAct_9fa48("1928")) {
      {}
    } else {
      stryCov_9fa48("1928");
      this.requireWrite();
      requireCanonicalScope(this, record.scope);
      const previous = this.epoch(record.scope);
      if (stryMutAct_9fa48("1931") ? record.epoch !== previous.epoch : stryMutAct_9fa48("1930") ? false : stryMutAct_9fa48("1929") ? true : (stryCov_9fa48("1929", "1930", "1931"), record.epoch === previous.epoch)) return;
      if (stryMutAct_9fa48("1934") ? record.epoch === previous.epoch + 1 : stryMutAct_9fa48("1933") ? false : stryMutAct_9fa48("1932") ? true : (stryCov_9fa48("1932", "1933", "1934"), record.epoch !== (stryMutAct_9fa48("1935") ? previous.epoch - 1 : (stryCov_9fa48("1935"), previous.epoch + 1)))) {
        if (stryMutAct_9fa48("1936")) {
          {}
        } else {
          stryCov_9fa48("1936");
          throw new AgentCoreError(stryMutAct_9fa48("1937") ? "" : (stryCov_9fa48("1937"), "protocol.revision-conflict"), stryMutAct_9fa48("1938") ? "" : (stryCov_9fa48("1938"), "Scope epoch writes must advance exactly once"));
        }
      }
      putCanonical(this.#epochs, scopeKey(record.scope), ScopeEpoch.encode(record), ScopeEpoch.decode, stryMutAct_9fa48("1939") ? () => undefined : (stryCov_9fa48("1939"), value => scopeKey(value.scope)), stryMutAct_9fa48("1940") ? "" : (stryCov_9fa48("1940"), "Scope epoch"));
    }
  }
  private applyBootstrap(plan: TenantControlBootstrapPlan): void {
    if (stryMutAct_9fa48("1941")) {
      {}
    } else {
      stryCov_9fa48("1941");
      const anchor = this.bootstrapAnchor();
      if (stryMutAct_9fa48("1944") ? (!plan.tenant.id.equals(anchor.tenantId) || !plan.owner.id.equals(anchor.principalId) || plan.tenant.kind !== anchor.tenantKind || plan.tenant.authorizationRevision.value !== Revision.initial().value || plan.ownerMembership.scope.kind !== "tenant" || !plan.ownerMembership.scope.tenantId.equals(anchor.tenantId) || plan.ownerMembership.subject.kind !== "principal" || !plan.ownerMembership.subject.principalId.equals(anchor.principalId) || !plan.ownerMembership.isActive) && plan.ownerMembership.revision.value !== Revision.initial().value : stryMutAct_9fa48("1943") ? false : stryMutAct_9fa48("1942") ? true : (stryCov_9fa48("1942", "1943", "1944"), (stryMutAct_9fa48("1946") ? (!plan.tenant.id.equals(anchor.tenantId) || !plan.owner.id.equals(anchor.principalId) || plan.tenant.kind !== anchor.tenantKind || plan.tenant.authorizationRevision.value !== Revision.initial().value || plan.ownerMembership.scope.kind !== "tenant" || !plan.ownerMembership.scope.tenantId.equals(anchor.tenantId) || plan.ownerMembership.subject.kind !== "principal" || !plan.ownerMembership.subject.principalId.equals(anchor.principalId)) && !plan.ownerMembership.isActive : stryMutAct_9fa48("1945") ? false : (stryCov_9fa48("1945", "1946"), (stryMutAct_9fa48("1948") ? (!plan.tenant.id.equals(anchor.tenantId) || !plan.owner.id.equals(anchor.principalId) || plan.tenant.kind !== anchor.tenantKind || plan.tenant.authorizationRevision.value !== Revision.initial().value || plan.ownerMembership.scope.kind !== "tenant" || !plan.ownerMembership.scope.tenantId.equals(anchor.tenantId) || plan.ownerMembership.subject.kind !== "principal") && !plan.ownerMembership.subject.principalId.equals(anchor.principalId) : stryMutAct_9fa48("1947") ? false : (stryCov_9fa48("1947", "1948"), (stryMutAct_9fa48("1950") ? (!plan.tenant.id.equals(anchor.tenantId) || !plan.owner.id.equals(anchor.principalId) || plan.tenant.kind !== anchor.tenantKind || plan.tenant.authorizationRevision.value !== Revision.initial().value || plan.ownerMembership.scope.kind !== "tenant" || !plan.ownerMembership.scope.tenantId.equals(anchor.tenantId)) && plan.ownerMembership.subject.kind !== "principal" : stryMutAct_9fa48("1949") ? false : (stryCov_9fa48("1949", "1950"), (stryMutAct_9fa48("1952") ? (!plan.tenant.id.equals(anchor.tenantId) || !plan.owner.id.equals(anchor.principalId) || plan.tenant.kind !== anchor.tenantKind || plan.tenant.authorizationRevision.value !== Revision.initial().value || plan.ownerMembership.scope.kind !== "tenant") && !plan.ownerMembership.scope.tenantId.equals(anchor.tenantId) : stryMutAct_9fa48("1951") ? false : (stryCov_9fa48("1951", "1952"), (stryMutAct_9fa48("1954") ? (!plan.tenant.id.equals(anchor.tenantId) || !plan.owner.id.equals(anchor.principalId) || plan.tenant.kind !== anchor.tenantKind || plan.tenant.authorizationRevision.value !== Revision.initial().value) && plan.ownerMembership.scope.kind !== "tenant" : stryMutAct_9fa48("1953") ? false : (stryCov_9fa48("1953", "1954"), (stryMutAct_9fa48("1956") ? (!plan.tenant.id.equals(anchor.tenantId) || !plan.owner.id.equals(anchor.principalId) || plan.tenant.kind !== anchor.tenantKind) && plan.tenant.authorizationRevision.value !== Revision.initial().value : stryMutAct_9fa48("1955") ? false : (stryCov_9fa48("1955", "1956"), (stryMutAct_9fa48("1958") ? (!plan.tenant.id.equals(anchor.tenantId) || !plan.owner.id.equals(anchor.principalId)) && plan.tenant.kind !== anchor.tenantKind : stryMutAct_9fa48("1957") ? false : (stryCov_9fa48("1957", "1958"), (stryMutAct_9fa48("1960") ? !plan.tenant.id.equals(anchor.tenantId) && !plan.owner.id.equals(anchor.principalId) : stryMutAct_9fa48("1959") ? false : (stryCov_9fa48("1959", "1960"), (stryMutAct_9fa48("1961") ? plan.tenant.id.equals(anchor.tenantId) : (stryCov_9fa48("1961"), !plan.tenant.id.equals(anchor.tenantId))) || (stryMutAct_9fa48("1962") ? plan.owner.id.equals(anchor.principalId) : (stryCov_9fa48("1962"), !plan.owner.id.equals(anchor.principalId))))) || (stryMutAct_9fa48("1964") ? plan.tenant.kind === anchor.tenantKind : stryMutAct_9fa48("1963") ? false : (stryCov_9fa48("1963", "1964"), plan.tenant.kind !== anchor.tenantKind)))) || (stryMutAct_9fa48("1966") ? plan.tenant.authorizationRevision.value === Revision.initial().value : stryMutAct_9fa48("1965") ? false : (stryCov_9fa48("1965", "1966"), plan.tenant.authorizationRevision.value !== Revision.initial().value)))) || (stryMutAct_9fa48("1968") ? plan.ownerMembership.scope.kind === "tenant" : stryMutAct_9fa48("1967") ? false : (stryCov_9fa48("1967", "1968"), plan.ownerMembership.scope.kind !== (stryMutAct_9fa48("1969") ? "" : (stryCov_9fa48("1969"), "tenant")))))) || (stryMutAct_9fa48("1970") ? plan.ownerMembership.scope.tenantId.equals(anchor.tenantId) : (stryCov_9fa48("1970"), !plan.ownerMembership.scope.tenantId.equals(anchor.tenantId))))) || (stryMutAct_9fa48("1972") ? plan.ownerMembership.subject.kind === "principal" : stryMutAct_9fa48("1971") ? false : (stryCov_9fa48("1971", "1972"), plan.ownerMembership.subject.kind !== (stryMutAct_9fa48("1973") ? "" : (stryCov_9fa48("1973"), "principal")))))) || (stryMutAct_9fa48("1974") ? plan.ownerMembership.subject.principalId.equals(anchor.principalId) : (stryCov_9fa48("1974"), !plan.ownerMembership.subject.principalId.equals(anchor.principalId))))) || (stryMutAct_9fa48("1975") ? plan.ownerMembership.isActive : (stryCov_9fa48("1975"), !plan.ownerMembership.isActive)))) || (stryMutAct_9fa48("1977") ? plan.ownerMembership.revision.value === Revision.initial().value : stryMutAct_9fa48("1976") ? false : (stryCov_9fa48("1976", "1977"), plan.ownerMembership.revision.value !== Revision.initial().value)))) {
        if (stryMutAct_9fa48("1978")) {
          {}
        } else {
          stryCov_9fa48("1978");
          throw new AgentCoreError(stryMutAct_9fa48("1979") ? "" : (stryCov_9fa48("1979"), "protocol.invalid-state"), stryMutAct_9fa48("1980") ? "" : (stryCov_9fa48("1980"), "Tenant bootstrap plan does not match its immutable anchor"));
        }
      }
      if (stryMutAct_9fa48("1983") ? new Set(plan.roles.map(role => role.name.value)).size !== plan.roles.length && !plan.roles.some(role => role.name.equals(plan.ownerMembership.role)) : stryMutAct_9fa48("1982") ? false : stryMutAct_9fa48("1981") ? true : (stryCov_9fa48("1981", "1982", "1983"), (stryMutAct_9fa48("1985") ? new Set(plan.roles.map(role => role.name.value)).size === plan.roles.length : stryMutAct_9fa48("1984") ? false : (stryCov_9fa48("1984", "1985"), new Set(plan.roles.map(stryMutAct_9fa48("1986") ? () => undefined : (stryCov_9fa48("1986"), role => role.name.value))).size !== plan.roles.length)) || (stryMutAct_9fa48("1987") ? plan.roles.some(role => role.name.equals(plan.ownerMembership.role)) : (stryCov_9fa48("1987"), !(stryMutAct_9fa48("1988") ? plan.roles.every(role => role.name.equals(plan.ownerMembership.role)) : (stryCov_9fa48("1988"), plan.roles.some(stryMutAct_9fa48("1989") ? () => undefined : (stryCov_9fa48("1989"), role => role.name.equals(plan.ownerMembership.role))))))))) {
        if (stryMutAct_9fa48("1990")) {
          {}
        } else {
          stryCov_9fa48("1990");
          throw new AgentCoreError(stryMutAct_9fa48("1991") ? "" : (stryCov_9fa48("1991"), "protocol.invalid-state"), stryMutAct_9fa48("1992") ? "" : (stryCov_9fa48("1992"), "Tenant bootstrap Roles are invalid"));
        }
      }
      this.putIdentity(stryMutAct_9fa48("1993") ? "" : (stryCov_9fa48("1993"), "tenant"), plan.tenant.id.value, Tenant.encode(plan.tenant));
      this.putPrincipal(plan.owner);
      for (const role of plan.roles) this.putRole(role);
      this.putMembership(plan.ownerMembership);
      for (const grant of plan.grants) this.putGrant(grant);
      for (const epoch of plan.epochs) this.putEpoch(epoch);
      this.#marker = Object.freeze(stryMutAct_9fa48("1994") ? {} : (stryCov_9fa48("1994"), {
        tenantId: anchor.tenantId,
        ownerPrincipalId: anchor.principalId,
        revision: plan.tenant.authorizationRevision.value
      }));
    }
  }
  private commit<Result>(mode: WriteMode, operation: (store: MemoryTenantControlStore) => Result): Result {
    if (stryMutAct_9fa48("1995")) {
      {}
    } else {
      stryCov_9fa48("1995");
      if (stryMutAct_9fa48("1997") ? false : stryMutAct_9fa48("1996") ? true : (stryCov_9fa48("1996", "1997"), this.#transactionActive)) {
        if (stryMutAct_9fa48("1998")) {
          {}
        } else {
          stryCov_9fa48("1998");
          throw new AgentCoreError(stryMutAct_9fa48("1999") ? "" : (stryCov_9fa48("1999"), "protocol.invalid-state"), stryMutAct_9fa48("2000") ? "" : (stryCov_9fa48("2000"), "Nested Memory Tenant control transactions are not supported"));
        }
      }
      this.#transactionActive = stryMutAct_9fa48("2001") ? false : (stryCov_9fa48("2001"), true);
      let candidate: MemoryTenantControlStore | undefined;
      try {
        if (stryMutAct_9fa48("2002")) {
          {}
        } else {
          stryCov_9fa48("2002");
          candidate = MemoryTenantControlStore.restore(this.snapshot());
          candidate.#writeMode = mode;
          const result = operation(candidate);
          if (stryMutAct_9fa48("2004") ? false : stryMutAct_9fa48("2003") ? true : (stryCov_9fa48("2003", "2004"), isPromiseLike(result))) {
            if (stryMutAct_9fa48("2005")) {
              {}
            } else {
              stryCov_9fa48("2005");
              if (stryMutAct_9fa48("2007") ? false : stryMutAct_9fa48("2006") ? true : (stryCov_9fa48("2006", "2007"), result instanceof Promise)) void result.catch(() => undefined);
              throw new AgentCoreError(stryMutAct_9fa48("2008") ? "" : (stryCov_9fa48("2008"), "protocol.invalid-state"), stryMutAct_9fa48("2009") ? "" : (stryCov_9fa48("2009"), "Memory Tenant control transactions must be synchronous"));
            }
          }
          candidate.#writeMode = undefined;
          candidate.assertRestoredState();
          this.replace(candidate);
          return result;
        }
      } finally {
        if (stryMutAct_9fa48("2010")) {
          {}
        } else {
          stryCov_9fa48("2010");
          if (stryMutAct_9fa48("2013") ? candidate === undefined : stryMutAct_9fa48("2012") ? false : stryMutAct_9fa48("2011") ? true : (stryCov_9fa48("2011", "2012", "2013"), candidate !== undefined)) candidate.#writeMode = undefined;
          this.#transactionActive = stryMutAct_9fa48("2014") ? true : (stryCov_9fa48("2014"), false);
        }
      }
    }
  }
  private identityRecord<Record>(kind: IdentityRecordKind, id: string, decode: (bytes: Uint8Array) => Record): Record | undefined {
    if (stryMutAct_9fa48("2015")) {
      {}
    } else {
      stryCov_9fa48("2015");
      const stored = this.#identity.get(identityKey(kind, id));
      return (stryMutAct_9fa48("2018") ? stored !== undefined : stryMutAct_9fa48("2017") ? false : stryMutAct_9fa48("2016") ? true : (stryCov_9fa48("2016", "2017", "2018"), stored === undefined)) ? undefined : decode(stryMutAct_9fa48("2019") ? stored.bytes : (stryCov_9fa48("2019"), stored.bytes.slice()));
    }
  }
  private identityRecords<Record>(kind: IdentityRecordKind, decode: (bytes: Uint8Array) => Record): readonly Record[] {
    if (stryMutAct_9fa48("2020")) {
      {}
    } else {
      stryCov_9fa48("2020");
      return Object.freeze(stryMutAct_9fa48("2022") ? [...this.#identity.values()].sort((left, right) => left.id.localeCompare(right.id)).map(record => decode(record.bytes.slice())) : stryMutAct_9fa48("2021") ? [...this.#identity.values()].filter(record => record.kind === kind).map(record => decode(record.bytes.slice())) : (stryCov_9fa48("2021", "2022"), (stryMutAct_9fa48("2023") ? [] : (stryCov_9fa48("2023"), [...this.#identity.values()])).filter(stryMutAct_9fa48("2024") ? () => undefined : (stryCov_9fa48("2024"), record => stryMutAct_9fa48("2027") ? record.kind !== kind : stryMutAct_9fa48("2026") ? false : stryMutAct_9fa48("2025") ? true : (stryCov_9fa48("2025", "2026", "2027"), record.kind === kind))).sort(stryMutAct_9fa48("2028") ? () => undefined : (stryCov_9fa48("2028"), (left, right) => left.id.localeCompare(right.id))).map(stryMutAct_9fa48("2029") ? () => undefined : (stryCov_9fa48("2029"), record => decode(stryMutAct_9fa48("2030") ? record.bytes : (stryCov_9fa48("2030"), record.bytes.slice()))))));
    }
  }
  private putIdentity(kind: IdentityRecordKind, id: string, bytes: Uint8Array): void {
    if (stryMutAct_9fa48("2031")) {
      {}
    } else {
      stryCov_9fa48("2031");
      this.requireWrite();
      const record = copyIdentityRecord(stryMutAct_9fa48("2032") ? {} : (stryCov_9fa48("2032"), {
        kind,
        id,
        bytes
      }));
      new MemoryIdentityRepository(stryMutAct_9fa48("2033") ? {} : (stryCov_9fa48("2033"), {
        version: SNAPSHOT_VERSION,
        records: stryMutAct_9fa48("2034") ? [] : (stryCov_9fa48("2034"), [record])
      }));
      this.#identity.set(identityKey(kind, id), record);
    }
  }
  private requireWrite(): void {
    if (stryMutAct_9fa48("2035")) {
      {}
    } else {
      stryCov_9fa48("2035");
      if (stryMutAct_9fa48("2038") ? this.#writeMode !== undefined : stryMutAct_9fa48("2037") ? false : stryMutAct_9fa48("2036") ? true : (stryCov_9fa48("2036", "2037", "2038"), this.#writeMode === undefined)) {
        if (stryMutAct_9fa48("2039")) {
          {}
        } else {
          stryCov_9fa48("2039");
          throw new AgentCoreError(stryMutAct_9fa48("2040") ? "" : (stryCov_9fa48("2040"), "protocol.invalid-state"), stryMutAct_9fa48("2041") ? "" : (stryCov_9fa48("2041"), "Tenant control records can only change inside an owned transaction"));
        }
      }
    }
  }
  private assertRestoredState(): void {
    if (stryMutAct_9fa48("2042")) {
      {}
    } else {
      stryCov_9fa48("2042");
      if (stryMutAct_9fa48("2045") ? this.#marker !== null : stryMutAct_9fa48("2044") ? false : stryMutAct_9fa48("2043") ? true : (stryCov_9fa48("2043", "2044", "2045"), this.#marker === null)) {
        if (stryMutAct_9fa48("2046")) {
          {}
        } else {
          stryCov_9fa48("2046");
          if (stryMutAct_9fa48("2049") ? false : stryMutAct_9fa48("2048") ? true : stryMutAct_9fa48("2047") ? this.isBootstrapEligible() : (stryCov_9fa48("2047", "2048", "2049"), !this.isBootstrapEligible())) {
            if (stryMutAct_9fa48("2050")) {
              {}
            } else {
              stryCov_9fa48("2050");
              throw corruptMemoryTenantControl(stryMutAct_9fa48("2051") ? "" : (stryCov_9fa48("2051"), "Unmarked Tenant control snapshot is not empty"));
            }
          }
          return;
        }
      }
      if (stryMutAct_9fa48("2054") ? (!this.#marker.tenantId.equals(this.#anchor.tenantId) || !this.#marker.ownerPrincipalId.equals(this.#anchor.principalId)) && this.#marker.revision !== Revision.initial().value : stryMutAct_9fa48("2053") ? false : stryMutAct_9fa48("2052") ? true : (stryCov_9fa48("2052", "2053", "2054"), (stryMutAct_9fa48("2056") ? !this.#marker.tenantId.equals(this.#anchor.tenantId) && !this.#marker.ownerPrincipalId.equals(this.#anchor.principalId) : stryMutAct_9fa48("2055") ? false : (stryCov_9fa48("2055", "2056"), (stryMutAct_9fa48("2057") ? this.#marker.tenantId.equals(this.#anchor.tenantId) : (stryCov_9fa48("2057"), !this.#marker.tenantId.equals(this.#anchor.tenantId))) || (stryMutAct_9fa48("2058") ? this.#marker.ownerPrincipalId.equals(this.#anchor.principalId) : (stryCov_9fa48("2058"), !this.#marker.ownerPrincipalId.equals(this.#anchor.principalId))))) || (stryMutAct_9fa48("2060") ? this.#marker.revision === Revision.initial().value : stryMutAct_9fa48("2059") ? false : (stryCov_9fa48("2059", "2060"), this.#marker.revision !== Revision.initial().value)))) {
        if (stryMutAct_9fa48("2061")) {
          {}
        } else {
          stryCov_9fa48("2061");
          throw corruptMemoryTenantControl(stryMutAct_9fa48("2062") ? "" : (stryCov_9fa48("2062"), "Tenant control marker does not match its anchor"));
        }
      }
      const tenant = this.tenant(this.tenantId);
      const owner = this.principal(this.#anchor.principalId);
      const bootstrap = createTenantControlBootstrapPlan(this.bootstrapAnchor(), Revision.initial());
      if (stryMutAct_9fa48("2065") ? (tenant === undefined || owner === undefined || tenant.kind !== this.#anchor.tenantKind || tenant.authorizationRevision.value < this.#marker.revision || this.identityRecords("tenant", Tenant.decode).length !== 1 || this.membership(bootstrap.ownerMembership.id) === undefined || bootstrap.roles.some(role => this.role(role.name) === undefined) || bootstrap.grants.some(grant => this.grant(grant.id) === undefined)) && this.epoch(bootstrap.epochs[0]!.scope).epoch < bootstrap.epochs[0]!.epoch : stryMutAct_9fa48("2064") ? false : stryMutAct_9fa48("2063") ? true : (stryCov_9fa48("2063", "2064", "2065"), (stryMutAct_9fa48("2067") ? (tenant === undefined || owner === undefined || tenant.kind !== this.#anchor.tenantKind || tenant.authorizationRevision.value < this.#marker.revision || this.identityRecords("tenant", Tenant.decode).length !== 1 || this.membership(bootstrap.ownerMembership.id) === undefined || bootstrap.roles.some(role => this.role(role.name) === undefined)) && bootstrap.grants.some(grant => this.grant(grant.id) === undefined) : stryMutAct_9fa48("2066") ? false : (stryCov_9fa48("2066", "2067"), (stryMutAct_9fa48("2069") ? (tenant === undefined || owner === undefined || tenant.kind !== this.#anchor.tenantKind || tenant.authorizationRevision.value < this.#marker.revision || this.identityRecords("tenant", Tenant.decode).length !== 1 || this.membership(bootstrap.ownerMembership.id) === undefined) && bootstrap.roles.some(role => this.role(role.name) === undefined) : stryMutAct_9fa48("2068") ? false : (stryCov_9fa48("2068", "2069"), (stryMutAct_9fa48("2071") ? (tenant === undefined || owner === undefined || tenant.kind !== this.#anchor.tenantKind || tenant.authorizationRevision.value < this.#marker.revision || this.identityRecords("tenant", Tenant.decode).length !== 1) && this.membership(bootstrap.ownerMembership.id) === undefined : stryMutAct_9fa48("2070") ? false : (stryCov_9fa48("2070", "2071"), (stryMutAct_9fa48("2073") ? (tenant === undefined || owner === undefined || tenant.kind !== this.#anchor.tenantKind || tenant.authorizationRevision.value < this.#marker.revision) && this.identityRecords("tenant", Tenant.decode).length !== 1 : stryMutAct_9fa48("2072") ? false : (stryCov_9fa48("2072", "2073"), (stryMutAct_9fa48("2075") ? (tenant === undefined || owner === undefined || tenant.kind !== this.#anchor.tenantKind) && tenant.authorizationRevision.value < this.#marker.revision : stryMutAct_9fa48("2074") ? false : (stryCov_9fa48("2074", "2075"), (stryMutAct_9fa48("2077") ? (tenant === undefined || owner === undefined) && tenant.kind !== this.#anchor.tenantKind : stryMutAct_9fa48("2076") ? false : (stryCov_9fa48("2076", "2077"), (stryMutAct_9fa48("2079") ? tenant === undefined && owner === undefined : stryMutAct_9fa48("2078") ? false : (stryCov_9fa48("2078", "2079"), (stryMutAct_9fa48("2081") ? tenant !== undefined : stryMutAct_9fa48("2080") ? false : (stryCov_9fa48("2080", "2081"), tenant === undefined)) || (stryMutAct_9fa48("2083") ? owner !== undefined : stryMutAct_9fa48("2082") ? false : (stryCov_9fa48("2082", "2083"), owner === undefined)))) || (stryMutAct_9fa48("2085") ? tenant.kind === this.#anchor.tenantKind : stryMutAct_9fa48("2084") ? false : (stryCov_9fa48("2084", "2085"), tenant.kind !== this.#anchor.tenantKind)))) || (stryMutAct_9fa48("2088") ? tenant.authorizationRevision.value >= this.#marker.revision : stryMutAct_9fa48("2087") ? tenant.authorizationRevision.value <= this.#marker.revision : stryMutAct_9fa48("2086") ? false : (stryCov_9fa48("2086", "2087", "2088"), tenant.authorizationRevision.value < this.#marker.revision)))) || (stryMutAct_9fa48("2090") ? this.identityRecords("tenant", Tenant.decode).length === 1 : stryMutAct_9fa48("2089") ? false : (stryCov_9fa48("2089", "2090"), this.identityRecords(stryMutAct_9fa48("2091") ? "" : (stryCov_9fa48("2091"), "tenant"), Tenant.decode).length !== 1)))) || (stryMutAct_9fa48("2093") ? this.membership(bootstrap.ownerMembership.id) !== undefined : stryMutAct_9fa48("2092") ? false : (stryCov_9fa48("2092", "2093"), this.membership(bootstrap.ownerMembership.id) === undefined)))) || (stryMutAct_9fa48("2094") ? bootstrap.roles.every(role => this.role(role.name) === undefined) : (stryCov_9fa48("2094"), bootstrap.roles.some(stryMutAct_9fa48("2095") ? () => undefined : (stryCov_9fa48("2095"), role => stryMutAct_9fa48("2098") ? this.role(role.name) !== undefined : stryMutAct_9fa48("2097") ? false : stryMutAct_9fa48("2096") ? true : (stryCov_9fa48("2096", "2097", "2098"), this.role(role.name) === undefined))))))) || (stryMutAct_9fa48("2099") ? bootstrap.grants.every(grant => this.grant(grant.id) === undefined) : (stryCov_9fa48("2099"), bootstrap.grants.some(stryMutAct_9fa48("2100") ? () => undefined : (stryCov_9fa48("2100"), grant => stryMutAct_9fa48("2103") ? this.grant(grant.id) !== undefined : stryMutAct_9fa48("2102") ? false : stryMutAct_9fa48("2101") ? true : (stryCov_9fa48("2101", "2102", "2103"), this.grant(grant.id) === undefined))))))) || (stryMutAct_9fa48("2106") ? this.epoch(bootstrap.epochs[0]!.scope).epoch >= bootstrap.epochs[0]!.epoch : stryMutAct_9fa48("2105") ? this.epoch(bootstrap.epochs[0]!.scope).epoch <= bootstrap.epochs[0]!.epoch : stryMutAct_9fa48("2104") ? false : (stryCov_9fa48("2104", "2105", "2106"), this.epoch(bootstrap.epochs[0]!.scope).epoch < bootstrap.epochs[0]!.epoch)))) {
        if (stryMutAct_9fa48("2107")) {
          {}
        } else {
          stryCov_9fa48("2107");
          throw corruptMemoryTenantControl(stryMutAct_9fa48("2108") ? "" : (stryCov_9fa48("2108"), "Bootstrapped Tenant identity closure is incomplete"));
        }
      }
      for (const team of this.teams()) {
        if (stryMutAct_9fa48("2109")) {
          {}
        } else {
          stryCov_9fa48("2109");
          requireLocalTenant(this.tenantId, team.tenantId, stryMutAct_9fa48("2110") ? "" : (stryCov_9fa48("2110"), "Team"));
          for (const principal of team.principals) {
            if (stryMutAct_9fa48("2111")) {
              {}
            } else {
              stryCov_9fa48("2111");
              if (stryMutAct_9fa48("2114") ? this.principal(principal) !== undefined : stryMutAct_9fa48("2113") ? false : stryMutAct_9fa48("2112") ? true : (stryCov_9fa48("2112", "2113", "2114"), this.principal(principal) === undefined)) {
                if (stryMutAct_9fa48("2115")) {
                  {}
                } else {
                  stryCov_9fa48("2115");
                  throw corruptMemoryTenantControl(stryMutAct_9fa48("2116") ? "" : (stryCov_9fa48("2116"), "Team references a missing Principal"));
                }
              }
            }
          }
        }
      }
      for (const project of this.identityRecords(stryMutAct_9fa48("2117") ? "" : (stryCov_9fa48("2117"), "project"), Project.decode)) {
        if (stryMutAct_9fa48("2118")) {
          {}
        } else {
          stryCov_9fa48("2118");
          requireLocalTenant(this.tenantId, project.tenantId, stryMutAct_9fa48("2119") ? "" : (stryCov_9fa48("2119"), "Project"));
        }
      }
      for (const workspace of this.identityRecords(stryMutAct_9fa48("2120") ? "" : (stryCov_9fa48("2120"), "workspace"), Workspace.decode)) {
        if (stryMutAct_9fa48("2121")) {
          {}
        } else {
          stryCov_9fa48("2121");
          requireLocalTenant(this.tenantId, workspace.tenantId, stryMutAct_9fa48("2122") ? "" : (stryCov_9fa48("2122"), "Workspace"));
          if (stryMutAct_9fa48("2125") ? workspace.projectId !== undefined || this.project(workspace.projectId) === undefined : stryMutAct_9fa48("2124") ? false : stryMutAct_9fa48("2123") ? true : (stryCov_9fa48("2123", "2124", "2125"), (stryMutAct_9fa48("2127") ? workspace.projectId === undefined : stryMutAct_9fa48("2126") ? true : (stryCov_9fa48("2126", "2127"), workspace.projectId !== undefined)) && (stryMutAct_9fa48("2129") ? this.project(workspace.projectId) !== undefined : stryMutAct_9fa48("2128") ? true : (stryCov_9fa48("2128", "2129"), this.project(workspace.projectId) === undefined)))) {
            if (stryMutAct_9fa48("2130")) {
              {}
            } else {
              stryCov_9fa48("2130");
              throw corruptMemoryTenantControl(stryMutAct_9fa48("2131") ? "" : (stryCov_9fa48("2131"), "Workspace references a missing Project"));
            }
          }
        }
      }
      for (const trust of this.guestTrusts()) {
        if (stryMutAct_9fa48("2132")) {
          {}
        } else {
          stryCov_9fa48("2132");
          requireLocalTenant(this.tenantId, trust.hostTenant, stryMutAct_9fa48("2133") ? "" : (stryCov_9fa48("2133"), "Guest trust"));
        }
      }
      for (const membership of this.memberships()) {
        if (stryMutAct_9fa48("2134")) {
          {}
        } else {
          stryCov_9fa48("2134");
          requireCanonicalScope(this, membership.scope);
          if (stryMutAct_9fa48("2137") ? this.role(membership.role) !== undefined : stryMutAct_9fa48("2136") ? false : stryMutAct_9fa48("2135") ? true : (stryCov_9fa48("2135", "2136", "2137"), this.role(membership.role) === undefined)) {
            if (stryMutAct_9fa48("2138")) {
              {}
            } else {
              stryCov_9fa48("2138");
              throw corruptMemoryTenantControl(stryMutAct_9fa48("2139") ? "" : (stryCov_9fa48("2139"), "Membership references a missing Role"));
            }
          }
          if (stryMutAct_9fa48("2142") ? membership.subject.kind === "principal" || this.principal(membership.subject.principalId) === undefined : stryMutAct_9fa48("2141") ? false : stryMutAct_9fa48("2140") ? true : (stryCov_9fa48("2140", "2141", "2142"), (stryMutAct_9fa48("2144") ? membership.subject.kind !== "principal" : stryMutAct_9fa48("2143") ? true : (stryCov_9fa48("2143", "2144"), membership.subject.kind === (stryMutAct_9fa48("2145") ? "" : (stryCov_9fa48("2145"), "principal")))) && (stryMutAct_9fa48("2147") ? this.principal(membership.subject.principalId) !== undefined : stryMutAct_9fa48("2146") ? true : (stryCov_9fa48("2146", "2147"), this.principal(membership.subject.principalId) === undefined)))) {
            if (stryMutAct_9fa48("2148")) {
              {}
            } else {
              stryCov_9fa48("2148");
              throw corruptMemoryTenantControl(stryMutAct_9fa48("2149") ? "" : (stryCov_9fa48("2149"), "Membership references a missing Principal"));
            }
          }
          if (stryMutAct_9fa48("2152") ? membership.subject.kind === "team" || this.team(membership.subject.teamId) === undefined : stryMutAct_9fa48("2151") ? false : stryMutAct_9fa48("2150") ? true : (stryCov_9fa48("2150", "2151", "2152"), (stryMutAct_9fa48("2154") ? membership.subject.kind !== "team" : stryMutAct_9fa48("2153") ? true : (stryCov_9fa48("2153", "2154"), membership.subject.kind === (stryMutAct_9fa48("2155") ? "" : (stryCov_9fa48("2155"), "team")))) && (stryMutAct_9fa48("2157") ? this.team(membership.subject.teamId) !== undefined : stryMutAct_9fa48("2156") ? true : (stryCov_9fa48("2156", "2157"), this.team(membership.subject.teamId) === undefined)))) {
            if (stryMutAct_9fa48("2158")) {
              {}
            } else {
              stryCov_9fa48("2158");
              throw corruptMemoryTenantControl(stryMutAct_9fa48("2159") ? "" : (stryCov_9fa48("2159"), "Membership references a missing Team"));
            }
          }
          if (stryMutAct_9fa48("2162") ? membership.subject.kind !== "foreign" : stryMutAct_9fa48("2161") ? false : stryMutAct_9fa48("2160") ? true : (stryCov_9fa48("2160", "2161", "2162"), membership.subject.kind === (stryMutAct_9fa48("2163") ? "" : (stryCov_9fa48("2163"), "foreign")))) {
            if (stryMutAct_9fa48("2164")) {
              {}
            } else {
              stryCov_9fa48("2164");
              const verification = membership.guestVerification;
              const trust = (stryMutAct_9fa48("2167") ? verification !== undefined : stryMutAct_9fa48("2166") ? false : stryMutAct_9fa48("2165") ? true : (stryCov_9fa48("2165", "2166", "2167"), verification === undefined)) ? undefined : this.guestTrust(verification.trustId);
              if (stryMutAct_9fa48("2170") ? (verification === undefined || trust === undefined || !trust.hostTenant.equals(this.tenantId) || !trust.homeTenant.equals(membership.subject.homeTenant)) && membership.state === "active" && (trust.revision.value !== verification.trustRevision.value || trust.verifier.kind !== verification.method || !trust.isActive) : stryMutAct_9fa48("2169") ? false : stryMutAct_9fa48("2168") ? true : (stryCov_9fa48("2168", "2169", "2170"), (stryMutAct_9fa48("2172") ? (verification === undefined || trust === undefined || !trust.hostTenant.equals(this.tenantId)) && !trust.homeTenant.equals(membership.subject.homeTenant) : stryMutAct_9fa48("2171") ? false : (stryCov_9fa48("2171", "2172"), (stryMutAct_9fa48("2174") ? (verification === undefined || trust === undefined) && !trust.hostTenant.equals(this.tenantId) : stryMutAct_9fa48("2173") ? false : (stryCov_9fa48("2173", "2174"), (stryMutAct_9fa48("2176") ? verification === undefined && trust === undefined : stryMutAct_9fa48("2175") ? false : (stryCov_9fa48("2175", "2176"), (stryMutAct_9fa48("2178") ? verification !== undefined : stryMutAct_9fa48("2177") ? false : (stryCov_9fa48("2177", "2178"), verification === undefined)) || (stryMutAct_9fa48("2180") ? trust !== undefined : stryMutAct_9fa48("2179") ? false : (stryCov_9fa48("2179", "2180"), trust === undefined)))) || (stryMutAct_9fa48("2181") ? trust.hostTenant.equals(this.tenantId) : (stryCov_9fa48("2181"), !trust.hostTenant.equals(this.tenantId))))) || (stryMutAct_9fa48("2182") ? trust.homeTenant.equals(membership.subject.homeTenant) : (stryCov_9fa48("2182"), !trust.homeTenant.equals(membership.subject.homeTenant))))) || (stryMutAct_9fa48("2184") ? membership.state === "active" || trust.revision.value !== verification.trustRevision.value || trust.verifier.kind !== verification.method || !trust.isActive : stryMutAct_9fa48("2183") ? false : (stryCov_9fa48("2183", "2184"), (stryMutAct_9fa48("2186") ? membership.state !== "active" : stryMutAct_9fa48("2185") ? true : (stryCov_9fa48("2185", "2186"), membership.state === (stryMutAct_9fa48("2187") ? "" : (stryCov_9fa48("2187"), "active")))) && (stryMutAct_9fa48("2189") ? (trust.revision.value !== verification.trustRevision.value || trust.verifier.kind !== verification.method) && !trust.isActive : stryMutAct_9fa48("2188") ? true : (stryCov_9fa48("2188", "2189"), (stryMutAct_9fa48("2191") ? trust.revision.value !== verification.trustRevision.value && trust.verifier.kind !== verification.method : stryMutAct_9fa48("2190") ? false : (stryCov_9fa48("2190", "2191"), (stryMutAct_9fa48("2193") ? trust.revision.value === verification.trustRevision.value : stryMutAct_9fa48("2192") ? false : (stryCov_9fa48("2192", "2193"), trust.revision.value !== verification.trustRevision.value)) || (stryMutAct_9fa48("2195") ? trust.verifier.kind === verification.method : stryMutAct_9fa48("2194") ? false : (stryCov_9fa48("2194", "2195"), trust.verifier.kind !== verification.method)))) || (stryMutAct_9fa48("2196") ? trust.isActive : (stryCov_9fa48("2196"), !trust.isActive)))))))) {
                if (stryMutAct_9fa48("2197")) {
                  {}
                } else {
                  stryCov_9fa48("2197");
                  throw corruptMemoryTenantControl(stryMutAct_9fa48("2198") ? "" : (stryCov_9fa48("2198"), "Guest Membership references invalid trust evidence"));
                }
              }
            }
          }
        }
      }
      const grants = this.grants();
      const grantsById = new Map(grants.map(stryMutAct_9fa48("2199") ? () => undefined : (stryCov_9fa48("2199"), grant => stryMutAct_9fa48("2200") ? [] : (stryCov_9fa48("2200"), [grant.id.value, grant]))));
      for (const grant of grants) {
        if (stryMutAct_9fa48("2201")) {
          {}
        } else {
          stryCov_9fa48("2201");
          requireCanonicalScope(this, grant.scope);
          if (stryMutAct_9fa48("2204") ? grant.subject.kind === "principal" || this.principal(grant.subject.principalId) === undefined : stryMutAct_9fa48("2203") ? false : stryMutAct_9fa48("2202") ? true : (stryCov_9fa48("2202", "2203", "2204"), (stryMutAct_9fa48("2206") ? grant.subject.kind !== "principal" : stryMutAct_9fa48("2205") ? true : (stryCov_9fa48("2205", "2206"), grant.subject.kind === (stryMutAct_9fa48("2207") ? "" : (stryCov_9fa48("2207"), "principal")))) && (stryMutAct_9fa48("2209") ? this.principal(grant.subject.principalId) !== undefined : stryMutAct_9fa48("2208") ? true : (stryCov_9fa48("2208", "2209"), this.principal(grant.subject.principalId) === undefined)))) {
            if (stryMutAct_9fa48("2210")) {
              {}
            } else {
              stryCov_9fa48("2210");
              throw corruptMemoryTenantControl(stryMutAct_9fa48("2211") ? "" : (stryCov_9fa48("2211"), "Grant references a missing Principal"));
            }
          }
          if (stryMutAct_9fa48("2214") ? grant.subject.kind === "team" || this.team(grant.subject.teamId) === undefined : stryMutAct_9fa48("2213") ? false : stryMutAct_9fa48("2212") ? true : (stryCov_9fa48("2212", "2213", "2214"), (stryMutAct_9fa48("2216") ? grant.subject.kind !== "team" : stryMutAct_9fa48("2215") ? true : (stryCov_9fa48("2215", "2216"), grant.subject.kind === (stryMutAct_9fa48("2217") ? "" : (stryCov_9fa48("2217"), "team")))) && (stryMutAct_9fa48("2219") ? this.team(grant.subject.teamId) !== undefined : stryMutAct_9fa48("2218") ? true : (stryCov_9fa48("2218", "2219"), this.team(grant.subject.teamId) === undefined)))) {
            if (stryMutAct_9fa48("2220")) {
              {}
            } else {
              stryCov_9fa48("2220");
              throw corruptMemoryTenantControl(stryMutAct_9fa48("2221") ? "" : (stryCov_9fa48("2221"), "Grant references a missing Team"));
            }
          }
          if (stryMutAct_9fa48("2224") ? grant.origin.kind !== "role" : stryMutAct_9fa48("2223") ? false : stryMutAct_9fa48("2222") ? true : (stryCov_9fa48("2222", "2223", "2224"), grant.origin.kind === (stryMutAct_9fa48("2225") ? "" : (stryCov_9fa48("2225"), "role")))) {
            if (stryMutAct_9fa48("2226")) {
              {}
            } else {
              stryCov_9fa48("2226");
              const membership = this.membership(grant.origin.membershipId);
              if (stryMutAct_9fa48("2229") ? (membership === undefined || membership.role.value !== grant.origin.roleName) && !sameSubject(membership, new Membership(membership.id, membership.scope, grant.subject, membership.role, membership.state, membership.revision)) : stryMutAct_9fa48("2228") ? false : stryMutAct_9fa48("2227") ? true : (stryCov_9fa48("2227", "2228", "2229"), (stryMutAct_9fa48("2231") ? membership === undefined && membership.role.value !== grant.origin.roleName : stryMutAct_9fa48("2230") ? false : (stryCov_9fa48("2230", "2231"), (stryMutAct_9fa48("2233") ? membership !== undefined : stryMutAct_9fa48("2232") ? false : (stryCov_9fa48("2232", "2233"), membership === undefined)) || (stryMutAct_9fa48("2235") ? membership.role.value === grant.origin.roleName : stryMutAct_9fa48("2234") ? false : (stryCov_9fa48("2234", "2235"), membership.role.value !== grant.origin.roleName)))) || (stryMutAct_9fa48("2236") ? sameSubject(membership, new Membership(membership.id, membership.scope, grant.subject, membership.role, membership.state, membership.revision)) : (stryCov_9fa48("2236"), !sameSubject(membership, new Membership(membership.id, membership.scope, grant.subject, membership.role, membership.state, membership.revision)))))) {
                if (stryMutAct_9fa48("2237")) {
                  {}
                } else {
                  stryCov_9fa48("2237");
                  throw corruptMemoryTenantControl(stryMutAct_9fa48("2238") ? "" : (stryCov_9fa48("2238"), "Role Grant references invalid Membership evidence"));
                }
              }
            }
          }
          if (stryMutAct_9fa48("2241") ? grant.attenuationOf === undefined : stryMutAct_9fa48("2240") ? false : stryMutAct_9fa48("2239") ? true : (stryCov_9fa48("2239", "2240", "2241"), grant.attenuationOf !== undefined)) {
            if (stryMutAct_9fa48("2242")) {
              {}
            } else {
              stryCov_9fa48("2242");
              const seen = new Set(stryMutAct_9fa48("2243") ? [] : (stryCov_9fa48("2243"), [grant.id.value]));
              let child = grant;
              while (stryMutAct_9fa48("2245") ? child.attenuationOf === undefined : stryMutAct_9fa48("2244") ? false : (stryCov_9fa48("2244", "2245"), child.attenuationOf !== undefined)) {
                if (stryMutAct_9fa48("2246")) {
                  {}
                } else {
                  stryCov_9fa48("2246");
                  if (stryMutAct_9fa48("2248") ? false : stryMutAct_9fa48("2247") ? true : (stryCov_9fa48("2247", "2248"), seen.has(child.attenuationOf.value))) {
                    if (stryMutAct_9fa48("2249")) {
                      {}
                    } else {
                      stryCov_9fa48("2249");
                      throw corruptMemoryTenantControl(stryMutAct_9fa48("2250") ? "" : (stryCov_9fa48("2250"), "Delegated Grant attenuation contains a cycle"));
                    }
                  }
                  seen.add(child.attenuationOf.value);
                  const parent = grantsById.get(child.attenuationOf.value);
                  if (stryMutAct_9fa48("2253") ? parent === undefined && !parent.canAttenuate(child) : stryMutAct_9fa48("2252") ? false : stryMutAct_9fa48("2251") ? true : (stryCov_9fa48("2251", "2252", "2253"), (stryMutAct_9fa48("2255") ? parent !== undefined : stryMutAct_9fa48("2254") ? false : (stryCov_9fa48("2254", "2255"), parent === undefined)) || (stryMutAct_9fa48("2256") ? parent.canAttenuate(child) : (stryCov_9fa48("2256"), !parent.canAttenuate(child))))) {
                    if (stryMutAct_9fa48("2257")) {
                      {}
                    } else {
                      stryCov_9fa48("2257");
                      throw corruptMemoryTenantControl(stryMutAct_9fa48("2258") ? "" : (stryCov_9fa48("2258"), "Delegated Grant references invalid parent authority"));
                    }
                  }
                  child = parent;
                }
              }
            }
          }
        }
      }
      for (const membership of this.memberships()) {
        if (stryMutAct_9fa48("2259")) {
          {}
        } else {
          stryCov_9fa48("2259");
          const role = this.role(membership.role)!;
          const owned = stryMutAct_9fa48("2260") ? grants : (stryCov_9fa48("2260"), grants.filter(stryMutAct_9fa48("2261") ? () => undefined : (stryCov_9fa48("2261"), grant => stryMutAct_9fa48("2264") ? grant.origin.kind === "role" || grant.origin.membershipId.equals(membership.id) : stryMutAct_9fa48("2263") ? false : stryMutAct_9fa48("2262") ? true : (stryCov_9fa48("2262", "2263", "2264"), (stryMutAct_9fa48("2266") ? grant.origin.kind !== "role" : stryMutAct_9fa48("2265") ? true : (stryCov_9fa48("2265", "2266"), grant.origin.kind === (stryMutAct_9fa48("2267") ? "" : (stryCov_9fa48("2267"), "role")))) && grant.origin.membershipId.equals(membership.id)))));
          const expected = new RoleGrantMaterializer().materialize(stryMutAct_9fa48("2268") ? {} : (stryCov_9fa48("2268"), {
            membership,
            role,
            existing: owned
          })).desiredRecords;
          if (stryMutAct_9fa48("2271") ? expected.length !== owned.length && expected.some(record => {
            const actual = owned.find(candidate => candidate.id.equals(record.id));
            return actual === undefined || !bytesEqual(Grant.encode(actual), Grant.encode(record));
          }) : stryMutAct_9fa48("2270") ? false : stryMutAct_9fa48("2269") ? true : (stryCov_9fa48("2269", "2270", "2271"), (stryMutAct_9fa48("2273") ? expected.length === owned.length : stryMutAct_9fa48("2272") ? false : (stryCov_9fa48("2272", "2273"), expected.length !== owned.length)) || (stryMutAct_9fa48("2274") ? expected.every(record => {
            const actual = owned.find(candidate => candidate.id.equals(record.id));
            return actual === undefined || !bytesEqual(Grant.encode(actual), Grant.encode(record));
          }) : (stryCov_9fa48("2274"), expected.some(record => {
            if (stryMutAct_9fa48("2275")) {
              {}
            } else {
              stryCov_9fa48("2275");
              const actual = owned.find(stryMutAct_9fa48("2276") ? () => undefined : (stryCov_9fa48("2276"), candidate => candidate.id.equals(record.id)));
              return stryMutAct_9fa48("2279") ? actual === undefined && !bytesEqual(Grant.encode(actual), Grant.encode(record)) : stryMutAct_9fa48("2278") ? false : stryMutAct_9fa48("2277") ? true : (stryCov_9fa48("2277", "2278", "2279"), (stryMutAct_9fa48("2281") ? actual !== undefined : stryMutAct_9fa48("2280") ? false : (stryCov_9fa48("2280", "2281"), actual === undefined)) || (stryMutAct_9fa48("2282") ? bytesEqual(Grant.encode(actual), Grant.encode(record)) : (stryCov_9fa48("2282"), !bytesEqual(Grant.encode(actual), Grant.encode(record)))));
            }
          }))))) {
            if (stryMutAct_9fa48("2283")) {
              {}
            } else {
              stryCov_9fa48("2283");
              throw corruptMemoryTenantControl(stryMutAct_9fa48("2284") ? "" : (stryCov_9fa48("2284"), "Role Grant materialization does not match Membership evidence"));
            }
          }
        }
      }
      for (const epoch of this.epochs()) requireCanonicalScope(this, epoch.scope);
    }
  }
  private replace(candidate: MemoryTenantControlStore): void {
    if (stryMutAct_9fa48("2285")) {
      {}
    } else {
      stryCov_9fa48("2285");
      this.#identity = new Map((stryMutAct_9fa48("2286") ? [] : (stryCov_9fa48("2286"), [...candidate.#identity])).map(stryMutAct_9fa48("2287") ? () => undefined : (stryCov_9fa48("2287"), ([key, record]) => stryMutAct_9fa48("2288") ? [] : (stryCov_9fa48("2288"), [key, copyIdentityRecord(record)]))));
      this.#grants = copyMap(candidate.#grants);
      this.#epochs = copyMap(candidate.#epochs);
      this.#marker = (stryMutAct_9fa48("2291") ? candidate.#marker !== null : stryMutAct_9fa48("2290") ? false : stryMutAct_9fa48("2289") ? true : (stryCov_9fa48("2289", "2290", "2291"), candidate.#marker === null)) ? null : copyMarkerSnapshot(candidate.#marker);
    }
  }
}
function requireSnapshot(snapshot: MemoryTenantControlSnapshot): void {
  if (stryMutAct_9fa48("2292")) {
    {}
  } else {
    stryCov_9fa48("2292");
    if (stryMutAct_9fa48("2295") ? (snapshot === null || typeof snapshot !== "object" || !hasExactKeys(snapshot, ["anchor", "epochs", "grants", "identity", "marker", "version"]) || snapshot.version !== SNAPSHOT_VERSION || !Array.isArray(snapshot.grants) || !Array.isArray(snapshot.epochs)) && snapshot.marker !== null && typeof snapshot.marker !== "object" : stryMutAct_9fa48("2294") ? false : stryMutAct_9fa48("2293") ? true : (stryCov_9fa48("2293", "2294", "2295"), (stryMutAct_9fa48("2297") ? (snapshot === null || typeof snapshot !== "object" || !hasExactKeys(snapshot, ["anchor", "epochs", "grants", "identity", "marker", "version"]) || snapshot.version !== SNAPSHOT_VERSION || !Array.isArray(snapshot.grants)) && !Array.isArray(snapshot.epochs) : stryMutAct_9fa48("2296") ? false : (stryCov_9fa48("2296", "2297"), (stryMutAct_9fa48("2299") ? (snapshot === null || typeof snapshot !== "object" || !hasExactKeys(snapshot, ["anchor", "epochs", "grants", "identity", "marker", "version"]) || snapshot.version !== SNAPSHOT_VERSION) && !Array.isArray(snapshot.grants) : stryMutAct_9fa48("2298") ? false : (stryCov_9fa48("2298", "2299"), (stryMutAct_9fa48("2301") ? (snapshot === null || typeof snapshot !== "object" || !hasExactKeys(snapshot, ["anchor", "epochs", "grants", "identity", "marker", "version"])) && snapshot.version !== SNAPSHOT_VERSION : stryMutAct_9fa48("2300") ? false : (stryCov_9fa48("2300", "2301"), (stryMutAct_9fa48("2303") ? (snapshot === null || typeof snapshot !== "object") && !hasExactKeys(snapshot, ["anchor", "epochs", "grants", "identity", "marker", "version"]) : stryMutAct_9fa48("2302") ? false : (stryCov_9fa48("2302", "2303"), (stryMutAct_9fa48("2305") ? snapshot === null && typeof snapshot !== "object" : stryMutAct_9fa48("2304") ? false : (stryCov_9fa48("2304", "2305"), (stryMutAct_9fa48("2307") ? snapshot !== null : stryMutAct_9fa48("2306") ? false : (stryCov_9fa48("2306", "2307"), snapshot === null)) || (stryMutAct_9fa48("2309") ? typeof snapshot === "object" : stryMutAct_9fa48("2308") ? false : (stryCov_9fa48("2308", "2309"), typeof snapshot !== (stryMutAct_9fa48("2310") ? "" : (stryCov_9fa48("2310"), "object")))))) || (stryMutAct_9fa48("2311") ? hasExactKeys(snapshot, ["anchor", "epochs", "grants", "identity", "marker", "version"]) : (stryCov_9fa48("2311"), !hasExactKeys(snapshot, stryMutAct_9fa48("2312") ? [] : (stryCov_9fa48("2312"), [stryMutAct_9fa48("2313") ? "" : (stryCov_9fa48("2313"), "anchor"), stryMutAct_9fa48("2314") ? "" : (stryCov_9fa48("2314"), "epochs"), stryMutAct_9fa48("2315") ? "" : (stryCov_9fa48("2315"), "grants"), stryMutAct_9fa48("2316") ? "" : (stryCov_9fa48("2316"), "identity"), stryMutAct_9fa48("2317") ? "" : (stryCov_9fa48("2317"), "marker"), stryMutAct_9fa48("2318") ? "" : (stryCov_9fa48("2318"), "version")])))))) || (stryMutAct_9fa48("2320") ? snapshot.version === SNAPSHOT_VERSION : stryMutAct_9fa48("2319") ? false : (stryCov_9fa48("2319", "2320"), snapshot.version !== SNAPSHOT_VERSION)))) || (stryMutAct_9fa48("2321") ? Array.isArray(snapshot.grants) : (stryCov_9fa48("2321"), !Array.isArray(snapshot.grants))))) || (stryMutAct_9fa48("2322") ? Array.isArray(snapshot.epochs) : (stryCov_9fa48("2322"), !Array.isArray(snapshot.epochs))))) || (stryMutAct_9fa48("2324") ? snapshot.marker !== null || typeof snapshot.marker !== "object" : stryMutAct_9fa48("2323") ? false : (stryCov_9fa48("2323", "2324"), (stryMutAct_9fa48("2326") ? snapshot.marker === null : stryMutAct_9fa48("2325") ? true : (stryCov_9fa48("2325", "2326"), snapshot.marker !== null)) && (stryMutAct_9fa48("2328") ? typeof snapshot.marker === "object" : stryMutAct_9fa48("2327") ? true : (stryCov_9fa48("2327", "2328"), typeof snapshot.marker !== (stryMutAct_9fa48("2329") ? "" : (stryCov_9fa48("2329"), "object")))))))) {
      if (stryMutAct_9fa48("2330")) {
        {}
      } else {
        stryCov_9fa48("2330");
        throw corruptMemoryTenantControl(stryMutAct_9fa48("2331") ? "" : (stryCov_9fa48("2331"), "Memory Tenant control snapshot is malformed"));
      }
    }
  }
}
function anchorSnapshot(anchor: TenantControlBootstrapAnchor): MemoryTenantControlAnchorSnapshot {
  if (stryMutAct_9fa48("2332")) {
    {}
  } else {
    stryCov_9fa48("2332");
    if (stryMutAct_9fa48("2335") ? (!(anchor.actorId instanceof ActorId) || !(anchor.tenantId instanceof TenantId) || !(anchor.principalId instanceof PrincipalId) || !(anchor.trustAnchor instanceof Uint8Array)) && anchor.trustAnchor.byteLength === 0 : stryMutAct_9fa48("2334") ? false : stryMutAct_9fa48("2333") ? true : (stryCov_9fa48("2333", "2334", "2335"), (stryMutAct_9fa48("2337") ? (!(anchor.actorId instanceof ActorId) || !(anchor.tenantId instanceof TenantId) || !(anchor.principalId instanceof PrincipalId)) && !(anchor.trustAnchor instanceof Uint8Array) : stryMutAct_9fa48("2336") ? false : (stryCov_9fa48("2336", "2337"), (stryMutAct_9fa48("2339") ? (!(anchor.actorId instanceof ActorId) || !(anchor.tenantId instanceof TenantId)) && !(anchor.principalId instanceof PrincipalId) : stryMutAct_9fa48("2338") ? false : (stryCov_9fa48("2338", "2339"), (stryMutAct_9fa48("2341") ? !(anchor.actorId instanceof ActorId) && !(anchor.tenantId instanceof TenantId) : stryMutAct_9fa48("2340") ? false : (stryCov_9fa48("2340", "2341"), (stryMutAct_9fa48("2342") ? anchor.actorId instanceof ActorId : (stryCov_9fa48("2342"), !(anchor.actorId instanceof ActorId))) || (stryMutAct_9fa48("2343") ? anchor.tenantId instanceof TenantId : (stryCov_9fa48("2343"), !(anchor.tenantId instanceof TenantId))))) || (stryMutAct_9fa48("2344") ? anchor.principalId instanceof PrincipalId : (stryCov_9fa48("2344"), !(anchor.principalId instanceof PrincipalId))))) || (stryMutAct_9fa48("2345") ? anchor.trustAnchor instanceof Uint8Array : (stryCov_9fa48("2345"), !(anchor.trustAnchor instanceof Uint8Array))))) || (stryMutAct_9fa48("2347") ? anchor.trustAnchor.byteLength !== 0 : stryMutAct_9fa48("2346") ? false : (stryCov_9fa48("2346", "2347"), anchor.trustAnchor.byteLength === 0)))) {
      if (stryMutAct_9fa48("2348")) {
        {}
      } else {
        stryCov_9fa48("2348");
        throw corruptMemoryTenantControl(stryMutAct_9fa48("2349") ? "" : (stryCov_9fa48("2349"), "Memory Tenant control bootstrap anchor is malformed"));
      }
    }
    const tenantKind = stryMutAct_9fa48("2350") ? anchor.tenantKind && "personal" : (stryCov_9fa48("2350"), anchor.tenantKind ?? (stryMutAct_9fa48("2351") ? "" : (stryCov_9fa48("2351"), "personal")));
    if (stryMutAct_9fa48("2354") ? tenantKind !== "personal" && tenantKind !== "organization" || tenantKind !== "service" : stryMutAct_9fa48("2353") ? false : stryMutAct_9fa48("2352") ? true : (stryCov_9fa48("2352", "2353", "2354"), (stryMutAct_9fa48("2356") ? tenantKind !== "personal" || tenantKind !== "organization" : stryMutAct_9fa48("2355") ? true : (stryCov_9fa48("2355", "2356"), (stryMutAct_9fa48("2358") ? tenantKind === "personal" : stryMutAct_9fa48("2357") ? true : (stryCov_9fa48("2357", "2358"), tenantKind !== (stryMutAct_9fa48("2359") ? "" : (stryCov_9fa48("2359"), "personal")))) && (stryMutAct_9fa48("2361") ? tenantKind === "organization" : stryMutAct_9fa48("2360") ? true : (stryCov_9fa48("2360", "2361"), tenantKind !== (stryMutAct_9fa48("2362") ? "" : (stryCov_9fa48("2362"), "organization")))))) && (stryMutAct_9fa48("2364") ? tenantKind === "service" : stryMutAct_9fa48("2363") ? true : (stryCov_9fa48("2363", "2364"), tenantKind !== (stryMutAct_9fa48("2365") ? "" : (stryCov_9fa48("2365"), "service")))))) {
      if (stryMutAct_9fa48("2366")) {
        {}
      } else {
        stryCov_9fa48("2366");
        throw corruptMemoryTenantControl(stryMutAct_9fa48("2367") ? "" : (stryCov_9fa48("2367"), "Memory Tenant control bootstrap Tenant kind is invalid"));
      }
    }
    return Object.freeze(stryMutAct_9fa48("2368") ? {} : (stryCov_9fa48("2368"), {
      actorId: anchor.actorId,
      tenantId: anchor.tenantId,
      principalId: anchor.principalId,
      tenantKind,
      trustAnchor: stryMutAct_9fa48("2369") ? anchor.trustAnchor : (stryCov_9fa48("2369"), anchor.trustAnchor.slice())
    }));
  }
}
function copyAnchorSnapshot(anchor: MemoryTenantControlAnchorSnapshot): MemoryTenantControlAnchorSnapshot {
  if (stryMutAct_9fa48("2370")) {
    {}
  } else {
    stryCov_9fa48("2370");
    if (stryMutAct_9fa48("2373") ? (anchor === null || typeof anchor !== "object" || !hasExactKeys(anchor, ["actorId", "principalId", "tenantId", "tenantKind", "trustAnchor"]) || !(anchor.actorId instanceof ActorId) || !(anchor.tenantId instanceof TenantId) || !(anchor.principalId instanceof PrincipalId) || !(anchor.trustAnchor instanceof Uint8Array)) && anchor.trustAnchor.byteLength === 0 : stryMutAct_9fa48("2372") ? false : stryMutAct_9fa48("2371") ? true : (stryCov_9fa48("2371", "2372", "2373"), (stryMutAct_9fa48("2375") ? (anchor === null || typeof anchor !== "object" || !hasExactKeys(anchor, ["actorId", "principalId", "tenantId", "tenantKind", "trustAnchor"]) || !(anchor.actorId instanceof ActorId) || !(anchor.tenantId instanceof TenantId) || !(anchor.principalId instanceof PrincipalId)) && !(anchor.trustAnchor instanceof Uint8Array) : stryMutAct_9fa48("2374") ? false : (stryCov_9fa48("2374", "2375"), (stryMutAct_9fa48("2377") ? (anchor === null || typeof anchor !== "object" || !hasExactKeys(anchor, ["actorId", "principalId", "tenantId", "tenantKind", "trustAnchor"]) || !(anchor.actorId instanceof ActorId) || !(anchor.tenantId instanceof TenantId)) && !(anchor.principalId instanceof PrincipalId) : stryMutAct_9fa48("2376") ? false : (stryCov_9fa48("2376", "2377"), (stryMutAct_9fa48("2379") ? (anchor === null || typeof anchor !== "object" || !hasExactKeys(anchor, ["actorId", "principalId", "tenantId", "tenantKind", "trustAnchor"]) || !(anchor.actorId instanceof ActorId)) && !(anchor.tenantId instanceof TenantId) : stryMutAct_9fa48("2378") ? false : (stryCov_9fa48("2378", "2379"), (stryMutAct_9fa48("2381") ? (anchor === null || typeof anchor !== "object" || !hasExactKeys(anchor, ["actorId", "principalId", "tenantId", "tenantKind", "trustAnchor"])) && !(anchor.actorId instanceof ActorId) : stryMutAct_9fa48("2380") ? false : (stryCov_9fa48("2380", "2381"), (stryMutAct_9fa48("2383") ? (anchor === null || typeof anchor !== "object") && !hasExactKeys(anchor, ["actorId", "principalId", "tenantId", "tenantKind", "trustAnchor"]) : stryMutAct_9fa48("2382") ? false : (stryCov_9fa48("2382", "2383"), (stryMutAct_9fa48("2385") ? anchor === null && typeof anchor !== "object" : stryMutAct_9fa48("2384") ? false : (stryCov_9fa48("2384", "2385"), (stryMutAct_9fa48("2387") ? anchor !== null : stryMutAct_9fa48("2386") ? false : (stryCov_9fa48("2386", "2387"), anchor === null)) || (stryMutAct_9fa48("2389") ? typeof anchor === "object" : stryMutAct_9fa48("2388") ? false : (stryCov_9fa48("2388", "2389"), typeof anchor !== (stryMutAct_9fa48("2390") ? "" : (stryCov_9fa48("2390"), "object")))))) || (stryMutAct_9fa48("2391") ? hasExactKeys(anchor, ["actorId", "principalId", "tenantId", "tenantKind", "trustAnchor"]) : (stryCov_9fa48("2391"), !hasExactKeys(anchor, stryMutAct_9fa48("2392") ? [] : (stryCov_9fa48("2392"), [stryMutAct_9fa48("2393") ? "" : (stryCov_9fa48("2393"), "actorId"), stryMutAct_9fa48("2394") ? "" : (stryCov_9fa48("2394"), "principalId"), stryMutAct_9fa48("2395") ? "" : (stryCov_9fa48("2395"), "tenantId"), stryMutAct_9fa48("2396") ? "" : (stryCov_9fa48("2396"), "tenantKind"), stryMutAct_9fa48("2397") ? "" : (stryCov_9fa48("2397"), "trustAnchor")])))))) || (stryMutAct_9fa48("2398") ? anchor.actorId instanceof ActorId : (stryCov_9fa48("2398"), !(anchor.actorId instanceof ActorId))))) || (stryMutAct_9fa48("2399") ? anchor.tenantId instanceof TenantId : (stryCov_9fa48("2399"), !(anchor.tenantId instanceof TenantId))))) || (stryMutAct_9fa48("2400") ? anchor.principalId instanceof PrincipalId : (stryCov_9fa48("2400"), !(anchor.principalId instanceof PrincipalId))))) || (stryMutAct_9fa48("2401") ? anchor.trustAnchor instanceof Uint8Array : (stryCov_9fa48("2401"), !(anchor.trustAnchor instanceof Uint8Array))))) || (stryMutAct_9fa48("2403") ? anchor.trustAnchor.byteLength !== 0 : stryMutAct_9fa48("2402") ? false : (stryCov_9fa48("2402", "2403"), anchor.trustAnchor.byteLength === 0)))) {
      if (stryMutAct_9fa48("2404")) {
        {}
      } else {
        stryCov_9fa48("2404");
        throw corruptMemoryTenantControl(stryMutAct_9fa48("2405") ? "" : (stryCov_9fa48("2405"), "Memory Tenant control bootstrap anchor is malformed"));
      }
    }
    requireTenantKind(anchor.tenantKind);
    return Object.freeze(stryMutAct_9fa48("2406") ? {} : (stryCov_9fa48("2406"), {
      ...anchor,
      actorId: new ActorId(anchor.actorId.value),
      tenantId: new TenantId(anchor.tenantId.value),
      principalId: new PrincipalId(anchor.principalId.value),
      trustAnchor: stryMutAct_9fa48("2407") ? anchor.trustAnchor : (stryCov_9fa48("2407"), anchor.trustAnchor.slice())
    }));
  }
}
function copyMarkerSnapshot(marker: MemoryTenantControlMarkerSnapshot): MemoryTenantControlMarkerSnapshot {
  if (stryMutAct_9fa48("2408")) {
    {}
  } else {
    stryCov_9fa48("2408");
    if (stryMutAct_9fa48("2411") ? (marker === null || typeof marker !== "object" || !hasExactKeys(marker, ["ownerPrincipalId", "revision", "tenantId"]) || !(marker.tenantId instanceof TenantId) || !(marker.ownerPrincipalId instanceof PrincipalId) || !Number.isSafeInteger(marker.revision)) && marker.revision < 0 : stryMutAct_9fa48("2410") ? false : stryMutAct_9fa48("2409") ? true : (stryCov_9fa48("2409", "2410", "2411"), (stryMutAct_9fa48("2413") ? (marker === null || typeof marker !== "object" || !hasExactKeys(marker, ["ownerPrincipalId", "revision", "tenantId"]) || !(marker.tenantId instanceof TenantId) || !(marker.ownerPrincipalId instanceof PrincipalId)) && !Number.isSafeInteger(marker.revision) : stryMutAct_9fa48("2412") ? false : (stryCov_9fa48("2412", "2413"), (stryMutAct_9fa48("2415") ? (marker === null || typeof marker !== "object" || !hasExactKeys(marker, ["ownerPrincipalId", "revision", "tenantId"]) || !(marker.tenantId instanceof TenantId)) && !(marker.ownerPrincipalId instanceof PrincipalId) : stryMutAct_9fa48("2414") ? false : (stryCov_9fa48("2414", "2415"), (stryMutAct_9fa48("2417") ? (marker === null || typeof marker !== "object" || !hasExactKeys(marker, ["ownerPrincipalId", "revision", "tenantId"])) && !(marker.tenantId instanceof TenantId) : stryMutAct_9fa48("2416") ? false : (stryCov_9fa48("2416", "2417"), (stryMutAct_9fa48("2419") ? (marker === null || typeof marker !== "object") && !hasExactKeys(marker, ["ownerPrincipalId", "revision", "tenantId"]) : stryMutAct_9fa48("2418") ? false : (stryCov_9fa48("2418", "2419"), (stryMutAct_9fa48("2421") ? marker === null && typeof marker !== "object" : stryMutAct_9fa48("2420") ? false : (stryCov_9fa48("2420", "2421"), (stryMutAct_9fa48("2423") ? marker !== null : stryMutAct_9fa48("2422") ? false : (stryCov_9fa48("2422", "2423"), marker === null)) || (stryMutAct_9fa48("2425") ? typeof marker === "object" : stryMutAct_9fa48("2424") ? false : (stryCov_9fa48("2424", "2425"), typeof marker !== (stryMutAct_9fa48("2426") ? "" : (stryCov_9fa48("2426"), "object")))))) || (stryMutAct_9fa48("2427") ? hasExactKeys(marker, ["ownerPrincipalId", "revision", "tenantId"]) : (stryCov_9fa48("2427"), !hasExactKeys(marker, stryMutAct_9fa48("2428") ? [] : (stryCov_9fa48("2428"), [stryMutAct_9fa48("2429") ? "" : (stryCov_9fa48("2429"), "ownerPrincipalId"), stryMutAct_9fa48("2430") ? "" : (stryCov_9fa48("2430"), "revision"), stryMutAct_9fa48("2431") ? "" : (stryCov_9fa48("2431"), "tenantId")])))))) || (stryMutAct_9fa48("2432") ? marker.tenantId instanceof TenantId : (stryCov_9fa48("2432"), !(marker.tenantId instanceof TenantId))))) || (stryMutAct_9fa48("2433") ? marker.ownerPrincipalId instanceof PrincipalId : (stryCov_9fa48("2433"), !(marker.ownerPrincipalId instanceof PrincipalId))))) || (stryMutAct_9fa48("2434") ? Number.isSafeInteger(marker.revision) : (stryCov_9fa48("2434"), !Number.isSafeInteger(marker.revision))))) || (stryMutAct_9fa48("2437") ? marker.revision >= 0 : stryMutAct_9fa48("2436") ? marker.revision <= 0 : stryMutAct_9fa48("2435") ? false : (stryCov_9fa48("2435", "2436", "2437"), marker.revision < 0)))) {
      if (stryMutAct_9fa48("2438")) {
        {}
      } else {
        stryCov_9fa48("2438");
        throw corruptMemoryTenantControl(stryMutAct_9fa48("2439") ? "" : (stryCov_9fa48("2439"), "Memory Tenant control bootstrap marker is malformed"));
      }
    }
    return Object.freeze(stryMutAct_9fa48("2440") ? {} : (stryCov_9fa48("2440"), {
      ...marker,
      tenantId: new TenantId(marker.tenantId.value),
      ownerPrincipalId: new PrincipalId(marker.ownerPrincipalId.value)
    }));
  }
}
function copyIdentityRecord(record: StoredIdentityRecord): StoredIdentityRecord {
  if (stryMutAct_9fa48("2441")) {
    {}
  } else {
    stryCov_9fa48("2441");
    return Object.freeze(stryMutAct_9fa48("2442") ? {} : (stryCov_9fa48("2442"), {
      kind: record.kind,
      id: record.id,
      bytes: stryMutAct_9fa48("2443") ? record.bytes : (stryCov_9fa48("2443"), record.bytes.slice())
    }));
  }
}
function loadRecords<Record>(records: readonly StoredTenantControlRecord[], decode: (bytes: Uint8Array) => Record, key: (record: Record) => string, name: string): RecordMap {
  if (stryMutAct_9fa48("2444")) {
    {}
  } else {
    stryCov_9fa48("2444");
    const map: RecordMap = new Map();
    for (const stored of records) {
      if (stryMutAct_9fa48("2445")) {
        {}
      } else {
        stryCov_9fa48("2445");
        if (stryMutAct_9fa48("2448") ? (stored === null || typeof stored !== "object" || !hasExactKeys(stored, ["bytes", "id"]) || typeof stored.id !== "string" || stored.id.length === 0) && !(stored.bytes instanceof Uint8Array) : stryMutAct_9fa48("2447") ? false : stryMutAct_9fa48("2446") ? true : (stryCov_9fa48("2446", "2447", "2448"), (stryMutAct_9fa48("2450") ? (stored === null || typeof stored !== "object" || !hasExactKeys(stored, ["bytes", "id"]) || typeof stored.id !== "string") && stored.id.length === 0 : stryMutAct_9fa48("2449") ? false : (stryCov_9fa48("2449", "2450"), (stryMutAct_9fa48("2452") ? (stored === null || typeof stored !== "object" || !hasExactKeys(stored, ["bytes", "id"])) && typeof stored.id !== "string" : stryMutAct_9fa48("2451") ? false : (stryCov_9fa48("2451", "2452"), (stryMutAct_9fa48("2454") ? (stored === null || typeof stored !== "object") && !hasExactKeys(stored, ["bytes", "id"]) : stryMutAct_9fa48("2453") ? false : (stryCov_9fa48("2453", "2454"), (stryMutAct_9fa48("2456") ? stored === null && typeof stored !== "object" : stryMutAct_9fa48("2455") ? false : (stryCov_9fa48("2455", "2456"), (stryMutAct_9fa48("2458") ? stored !== null : stryMutAct_9fa48("2457") ? false : (stryCov_9fa48("2457", "2458"), stored === null)) || (stryMutAct_9fa48("2460") ? typeof stored === "object" : stryMutAct_9fa48("2459") ? false : (stryCov_9fa48("2459", "2460"), typeof stored !== (stryMutAct_9fa48("2461") ? "" : (stryCov_9fa48("2461"), "object")))))) || (stryMutAct_9fa48("2462") ? hasExactKeys(stored, ["bytes", "id"]) : (stryCov_9fa48("2462"), !hasExactKeys(stored, stryMutAct_9fa48("2463") ? [] : (stryCov_9fa48("2463"), [stryMutAct_9fa48("2464") ? "" : (stryCov_9fa48("2464"), "bytes"), stryMutAct_9fa48("2465") ? "" : (stryCov_9fa48("2465"), "id")])))))) || (stryMutAct_9fa48("2467") ? typeof stored.id === "string" : stryMutAct_9fa48("2466") ? false : (stryCov_9fa48("2466", "2467"), typeof stored.id !== (stryMutAct_9fa48("2468") ? "" : (stryCov_9fa48("2468"), "string")))))) || (stryMutAct_9fa48("2470") ? stored.id.length !== 0 : stryMutAct_9fa48("2469") ? false : (stryCov_9fa48("2469", "2470"), stored.id.length === 0)))) || (stryMutAct_9fa48("2471") ? stored.bytes instanceof Uint8Array : (stryCov_9fa48("2471"), !(stored.bytes instanceof Uint8Array))))) {
          if (stryMutAct_9fa48("2472")) {
            {}
          } else {
            stryCov_9fa48("2472");
            throw corruptMemoryTenantControl(stryMutAct_9fa48("2473") ? `` : (stryCov_9fa48("2473"), `Memory Tenant control ${name} snapshot record is malformed`));
          }
        }
        if (stryMutAct_9fa48("2475") ? false : stryMutAct_9fa48("2474") ? true : (stryCov_9fa48("2474", "2475"), map.has(stored.id))) {
          if (stryMutAct_9fa48("2476")) {
            {}
          } else {
            stryCov_9fa48("2476");
            throw corruptMemoryTenantControl(stryMutAct_9fa48("2477") ? `` : (stryCov_9fa48("2477"), `Memory Tenant control snapshot contains duplicate ${name} records`));
          }
        }
        const bytes = stryMutAct_9fa48("2478") ? stored.bytes : (stryCov_9fa48("2478"), stored.bytes.slice());
        const record = decode(bytes);
        if (stryMutAct_9fa48("2481") ? key(record) === stored.id : stryMutAct_9fa48("2480") ? false : stryMutAct_9fa48("2479") ? true : (stryCov_9fa48("2479", "2480", "2481"), key(record) !== stored.id)) {
          if (stryMutAct_9fa48("2482")) {
            {}
          } else {
            stryCov_9fa48("2482");
            throw corruptMemoryTenantControl(stryMutAct_9fa48("2483") ? `` : (stryCov_9fa48("2483"), `${name} snapshot key does not match codec bytes`));
          }
        }
        map.set(stored.id, bytes);
      }
    }
    return map;
  }
}
function snapshotRecords(map: RecordMap): readonly StoredTenantControlRecord[] {
  if (stryMutAct_9fa48("2484")) {
    {}
  } else {
    stryCov_9fa48("2484");
    return Object.freeze(stryMutAct_9fa48("2485") ? [...map.entries()].map(([id, bytes]) => Object.freeze({
      id,
      bytes: bytes.slice()
    })) : (stryCov_9fa48("2485"), (stryMutAct_9fa48("2486") ? [] : (stryCov_9fa48("2486"), [...map.entries()])).sort(stryMutAct_9fa48("2487") ? () => undefined : (stryCov_9fa48("2487"), ([left], [right]) => left.localeCompare(right))).map(stryMutAct_9fa48("2488") ? () => undefined : (stryCov_9fa48("2488"), ([id, bytes]) => Object.freeze(stryMutAct_9fa48("2489") ? {} : (stryCov_9fa48("2489"), {
      id,
      bytes: stryMutAct_9fa48("2490") ? bytes : (stryCov_9fa48("2490"), bytes.slice())
    }))))));
  }
}
function decodeRecord<Record>(map: RecordMap, id: string, decode: (bytes: Uint8Array) => Record, key: (record: Record) => string, name: string): Record | undefined {
  if (stryMutAct_9fa48("2491")) {
    {}
  } else {
    stryCov_9fa48("2491");
    const bytes = map.get(id);
    if (stryMutAct_9fa48("2494") ? bytes !== undefined : stryMutAct_9fa48("2493") ? false : stryMutAct_9fa48("2492") ? true : (stryCov_9fa48("2492", "2493", "2494"), bytes === undefined)) return undefined;
    const record = decode(stryMutAct_9fa48("2495") ? bytes : (stryCov_9fa48("2495"), bytes.slice()));
    if (stryMutAct_9fa48("2498") ? key(record) === id : stryMutAct_9fa48("2497") ? false : stryMutAct_9fa48("2496") ? true : (stryCov_9fa48("2496", "2497", "2498"), key(record) !== id)) {
      if (stryMutAct_9fa48("2499")) {
        {}
      } else {
        stryCov_9fa48("2499");
        throw corruptMemoryTenantControl(stryMutAct_9fa48("2500") ? `` : (stryCov_9fa48("2500"), `${name} key does not match codec bytes`));
      }
    }
    return record;
  }
}
function decodeRecords<Record>(map: RecordMap, decode: (bytes: Uint8Array) => Record, key: (record: Record) => string, name: string): readonly Record[] {
  if (stryMutAct_9fa48("2501")) {
    {}
  } else {
    stryCov_9fa48("2501");
    return Object.freeze(stryMutAct_9fa48("2502") ? [...map.keys()].map(id => decodeRecord(map, id, decode, key, name)!) : (stryCov_9fa48("2502"), (stryMutAct_9fa48("2503") ? [] : (stryCov_9fa48("2503"), [...map.keys()])).sort().map(stryMutAct_9fa48("2504") ? () => undefined : (stryCov_9fa48("2504"), id => decodeRecord(map, id, decode, key, name)!))));
  }
}
function putCanonical<Record>(map: RecordMap, id: string, bytes: Uint8Array, decode: (bytes: Uint8Array) => Record, key: (record: Record) => string, name: string): void {
  if (stryMutAct_9fa48("2505")) {
    {}
  } else {
    stryCov_9fa48("2505");
    const record = decode(bytes);
    if (stryMutAct_9fa48("2508") ? key(record) === id : stryMutAct_9fa48("2507") ? false : stryMutAct_9fa48("2506") ? true : (stryCov_9fa48("2506", "2507", "2508"), key(record) !== id)) {
      if (stryMutAct_9fa48("2509")) {
        {}
      } else {
        stryCov_9fa48("2509");
        throw corruptMemoryTenantControl(stryMutAct_9fa48("2510") ? `` : (stryCov_9fa48("2510"), `${name} key does not match codec bytes`));
      }
    }
    map.set(id, stryMutAct_9fa48("2511") ? bytes : (stryCov_9fa48("2511"), bytes.slice()));
  }
}
function identityKey(kind: IdentityRecordKind, id: string): string {
  if (stryMutAct_9fa48("2512")) {
    {}
  } else {
    stryCov_9fa48("2512");
    return stryMutAct_9fa48("2513") ? `` : (stryCov_9fa48("2513"), `${kind}\u0000${id}`);
  }
}
function copyMap(map: RecordMap): RecordMap {
  if (stryMutAct_9fa48("2514")) {
    {}
  } else {
    stryCov_9fa48("2514");
    return new Map((stryMutAct_9fa48("2515") ? [] : (stryCov_9fa48("2515"), [...map])).map(stryMutAct_9fa48("2516") ? () => undefined : (stryCov_9fa48("2516"), ([key, bytes]) => stryMutAct_9fa48("2517") ? [] : (stryCov_9fa48("2517"), [key, stryMutAct_9fa48("2518") ? bytes : (stryCov_9fa48("2518"), bytes.slice())]))));
  }
}
function requireCanonicalScope(store: MemoryTenantControlStore, scope: ScopeEpoch["scope"]): void {
  if (stryMutAct_9fa48("2519")) {
    {}
  } else {
    stryCov_9fa48("2519");
    requireLocalTenant(store.tenantId, scope.tenantId, stryMutAct_9fa48("2520") ? "" : (stryCov_9fa48("2520"), "Authority Scope"));
    if (stryMutAct_9fa48("2523") ? scope.kind === "project" || scope.projectId === undefined || store.project(scope.projectId) === undefined : stryMutAct_9fa48("2522") ? false : stryMutAct_9fa48("2521") ? true : (stryCov_9fa48("2521", "2522", "2523"), (stryMutAct_9fa48("2525") ? scope.kind !== "project" : stryMutAct_9fa48("2524") ? true : (stryCov_9fa48("2524", "2525"), scope.kind === (stryMutAct_9fa48("2526") ? "" : (stryCov_9fa48("2526"), "project")))) && (stryMutAct_9fa48("2528") ? scope.projectId === undefined && store.project(scope.projectId) === undefined : stryMutAct_9fa48("2527") ? true : (stryCov_9fa48("2527", "2528"), (stryMutAct_9fa48("2530") ? scope.projectId !== undefined : stryMutAct_9fa48("2529") ? false : (stryCov_9fa48("2529", "2530"), scope.projectId === undefined)) || (stryMutAct_9fa48("2532") ? store.project(scope.projectId) !== undefined : stryMutAct_9fa48("2531") ? false : (stryCov_9fa48("2531", "2532"), store.project(scope.projectId) === undefined)))))) {
      if (stryMutAct_9fa48("2533")) {
        {}
      } else {
        stryCov_9fa48("2533");
        throw corruptMemoryTenantControl(stryMutAct_9fa48("2534") ? "" : (stryCov_9fa48("2534"), "Authority Project Scope is not canonical"));
      }
    }
    if (stryMutAct_9fa48("2537") ? scope.kind !== "workspace" : stryMutAct_9fa48("2536") ? false : stryMutAct_9fa48("2535") ? true : (stryCov_9fa48("2535", "2536", "2537"), scope.kind === (stryMutAct_9fa48("2538") ? "" : (stryCov_9fa48("2538"), "workspace")))) {
      if (stryMutAct_9fa48("2539")) {
        {}
      } else {
        stryCov_9fa48("2539");
        const workspace = (stryMutAct_9fa48("2542") ? scope.workspaceId !== undefined : stryMutAct_9fa48("2541") ? false : stryMutAct_9fa48("2540") ? true : (stryCov_9fa48("2540", "2541", "2542"), scope.workspaceId === undefined)) ? undefined : store.workspace(scope.workspaceId);
        if (stryMutAct_9fa48("2545") ? workspace === undefined && !workspace.scope.equals(scope) : stryMutAct_9fa48("2544") ? false : stryMutAct_9fa48("2543") ? true : (stryCov_9fa48("2543", "2544", "2545"), (stryMutAct_9fa48("2547") ? workspace !== undefined : stryMutAct_9fa48("2546") ? false : (stryCov_9fa48("2546", "2547"), workspace === undefined)) || (stryMutAct_9fa48("2548") ? workspace.scope.equals(scope) : (stryCov_9fa48("2548"), !workspace.scope.equals(scope))))) {
          if (stryMutAct_9fa48("2549")) {
            {}
          } else {
            stryCov_9fa48("2549");
            throw corruptMemoryTenantControl(stryMutAct_9fa48("2550") ? "" : (stryCov_9fa48("2550"), "Authority Workspace Scope is not canonical"));
          }
        }
      }
    }
  }
}
function requireLocalTenant(expected: TenantId, actual: TenantId, subject: string): void {
  if (stryMutAct_9fa48("2551")) {
    {}
  } else {
    stryCov_9fa48("2551");
    if (stryMutAct_9fa48("2554") ? false : stryMutAct_9fa48("2553") ? true : stryMutAct_9fa48("2552") ? actual.equals(expected) : (stryCov_9fa48("2552", "2553", "2554"), !actual.equals(expected))) {
      if (stryMutAct_9fa48("2555")) {
        {}
      } else {
        stryCov_9fa48("2555");
        throw new AgentCoreError(stryMutAct_9fa48("2556") ? "" : (stryCov_9fa48("2556"), "protocol.invalid-state"), stryMutAct_9fa48("2557") ? `` : (stryCov_9fa48("2557"), `${subject} belongs to another Tenant`));
      }
    }
  }
}
function sameSubject(left: Membership, right: Membership): boolean {
  if (stryMutAct_9fa48("2558")) {
    {}
  } else {
    stryCov_9fa48("2558");
    if (stryMutAct_9fa48("2561") ? left.subject.kind === right.subject.kind : stryMutAct_9fa48("2560") ? false : stryMutAct_9fa48("2559") ? true : (stryCov_9fa48("2559", "2560", "2561"), left.subject.kind !== right.subject.kind)) return stryMutAct_9fa48("2562") ? true : (stryCov_9fa48("2562"), false);
    if (stryMutAct_9fa48("2565") ? left.subject.kind === "principal" || right.subject.kind === "principal" : stryMutAct_9fa48("2564") ? false : stryMutAct_9fa48("2563") ? true : (stryCov_9fa48("2563", "2564", "2565"), (stryMutAct_9fa48("2567") ? left.subject.kind !== "principal" : stryMutAct_9fa48("2566") ? true : (stryCov_9fa48("2566", "2567"), left.subject.kind === (stryMutAct_9fa48("2568") ? "" : (stryCov_9fa48("2568"), "principal")))) && (stryMutAct_9fa48("2570") ? right.subject.kind !== "principal" : stryMutAct_9fa48("2569") ? true : (stryCov_9fa48("2569", "2570"), right.subject.kind === (stryMutAct_9fa48("2571") ? "" : (stryCov_9fa48("2571"), "principal")))))) {
      if (stryMutAct_9fa48("2572")) {
        {}
      } else {
        stryCov_9fa48("2572");
        return left.subject.principalId.equals(right.subject.principalId);
      }
    }
    if (stryMutAct_9fa48("2575") ? left.subject.kind === "team" || right.subject.kind === "team" : stryMutAct_9fa48("2574") ? false : stryMutAct_9fa48("2573") ? true : (stryCov_9fa48("2573", "2574", "2575"), (stryMutAct_9fa48("2577") ? left.subject.kind !== "team" : stryMutAct_9fa48("2576") ? true : (stryCov_9fa48("2576", "2577"), left.subject.kind === (stryMutAct_9fa48("2578") ? "" : (stryCov_9fa48("2578"), "team")))) && (stryMutAct_9fa48("2580") ? right.subject.kind !== "team" : stryMutAct_9fa48("2579") ? true : (stryCov_9fa48("2579", "2580"), right.subject.kind === (stryMutAct_9fa48("2581") ? "" : (stryCov_9fa48("2581"), "team")))))) {
      if (stryMutAct_9fa48("2582")) {
        {}
      } else {
        stryCov_9fa48("2582");
        return left.subject.teamId.equals(right.subject.teamId);
      }
    }
    return stryMutAct_9fa48("2585") ? left.subject.kind === "foreign" && right.subject.kind === "foreign" && left.subject.homeTenant.equals(right.subject.homeTenant) && left.subject.principalId.equals(right.subject.principalId) || left.subject.verifiedVia.equals(right.subject.verifiedVia) : stryMutAct_9fa48("2584") ? false : stryMutAct_9fa48("2583") ? true : (stryCov_9fa48("2583", "2584", "2585"), (stryMutAct_9fa48("2587") ? left.subject.kind === "foreign" && right.subject.kind === "foreign" && left.subject.homeTenant.equals(right.subject.homeTenant) || left.subject.principalId.equals(right.subject.principalId) : stryMutAct_9fa48("2586") ? true : (stryCov_9fa48("2586", "2587"), (stryMutAct_9fa48("2589") ? left.subject.kind === "foreign" && right.subject.kind === "foreign" || left.subject.homeTenant.equals(right.subject.homeTenant) : stryMutAct_9fa48("2588") ? true : (stryCov_9fa48("2588", "2589"), (stryMutAct_9fa48("2591") ? left.subject.kind === "foreign" || right.subject.kind === "foreign" : stryMutAct_9fa48("2590") ? true : (stryCov_9fa48("2590", "2591"), (stryMutAct_9fa48("2593") ? left.subject.kind !== "foreign" : stryMutAct_9fa48("2592") ? true : (stryCov_9fa48("2592", "2593"), left.subject.kind === (stryMutAct_9fa48("2594") ? "" : (stryCov_9fa48("2594"), "foreign")))) && (stryMutAct_9fa48("2596") ? right.subject.kind !== "foreign" : stryMutAct_9fa48("2595") ? true : (stryCov_9fa48("2595", "2596"), right.subject.kind === (stryMutAct_9fa48("2597") ? "" : (stryCov_9fa48("2597"), "foreign")))))) && left.subject.homeTenant.equals(right.subject.homeTenant))) && left.subject.principalId.equals(right.subject.principalId))) && left.subject.verifiedVia.equals(right.subject.verifiedVia));
  }
}
function anchorsEqual(left: TenantControlBootstrapAnchor, right: TenantControlBootstrapAnchor): boolean {
  if (stryMutAct_9fa48("2598")) {
    {}
  } else {
    stryCov_9fa48("2598");
    return stryMutAct_9fa48("2601") ? left.actorId.equals(right.actorId) && left.tenantId.equals(right.tenantId) && left.principalId.equals(right.principalId) && (left.tenantKind ?? "personal") === (right.tenantKind ?? "personal") || bytesEqual(left.trustAnchor, right.trustAnchor) : stryMutAct_9fa48("2600") ? false : stryMutAct_9fa48("2599") ? true : (stryCov_9fa48("2599", "2600", "2601"), (stryMutAct_9fa48("2603") ? left.actorId.equals(right.actorId) && left.tenantId.equals(right.tenantId) && left.principalId.equals(right.principalId) || (left.tenantKind ?? "personal") === (right.tenantKind ?? "personal") : stryMutAct_9fa48("2602") ? true : (stryCov_9fa48("2602", "2603"), (stryMutAct_9fa48("2605") ? left.actorId.equals(right.actorId) && left.tenantId.equals(right.tenantId) || left.principalId.equals(right.principalId) : stryMutAct_9fa48("2604") ? true : (stryCov_9fa48("2604", "2605"), (stryMutAct_9fa48("2607") ? left.actorId.equals(right.actorId) || left.tenantId.equals(right.tenantId) : stryMutAct_9fa48("2606") ? true : (stryCov_9fa48("2606", "2607"), left.actorId.equals(right.actorId) && left.tenantId.equals(right.tenantId))) && left.principalId.equals(right.principalId))) && (stryMutAct_9fa48("2609") ? (left.tenantKind ?? "personal") !== (right.tenantKind ?? "personal") : stryMutAct_9fa48("2608") ? true : (stryCov_9fa48("2608", "2609"), (stryMutAct_9fa48("2610") ? left.tenantKind && "personal" : (stryCov_9fa48("2610"), left.tenantKind ?? (stryMutAct_9fa48("2611") ? "" : (stryCov_9fa48("2611"), "personal")))) === (stryMutAct_9fa48("2612") ? right.tenantKind && "personal" : (stryCov_9fa48("2612"), right.tenantKind ?? (stryMutAct_9fa48("2613") ? "" : (stryCov_9fa48("2613"), "personal")))))))) && bytesEqual(left.trustAnchor, right.trustAnchor));
  }
}
function requireTenantKind(value: string): asserts value is TenantKind {
  if (stryMutAct_9fa48("2614")) {
    {}
  } else {
    stryCov_9fa48("2614");
    if (stryMutAct_9fa48("2617") ? value !== "personal" && value !== "organization" || value !== "service" : stryMutAct_9fa48("2616") ? false : stryMutAct_9fa48("2615") ? true : (stryCov_9fa48("2615", "2616", "2617"), (stryMutAct_9fa48("2619") ? value !== "personal" || value !== "organization" : stryMutAct_9fa48("2618") ? true : (stryCov_9fa48("2618", "2619"), (stryMutAct_9fa48("2621") ? value === "personal" : stryMutAct_9fa48("2620") ? true : (stryCov_9fa48("2620", "2621"), value !== (stryMutAct_9fa48("2622") ? "" : (stryCov_9fa48("2622"), "personal")))) && (stryMutAct_9fa48("2624") ? value === "organization" : stryMutAct_9fa48("2623") ? true : (stryCov_9fa48("2623", "2624"), value !== (stryMutAct_9fa48("2625") ? "" : (stryCov_9fa48("2625"), "organization")))))) && (stryMutAct_9fa48("2627") ? value === "service" : stryMutAct_9fa48("2626") ? true : (stryCov_9fa48("2626", "2627"), value !== (stryMutAct_9fa48("2628") ? "" : (stryCov_9fa48("2628"), "service")))))) {
      if (stryMutAct_9fa48("2629")) {
        {}
      } else {
        stryCov_9fa48("2629");
        throw corruptMemoryTenantControl(stryMutAct_9fa48("2630") ? "" : (stryCov_9fa48("2630"), "Memory Tenant control bootstrap Tenant kind is invalid"));
      }
    }
  }
}
function corruptMemoryTenantControl(message: string): AgentCoreError {
  if (stryMutAct_9fa48("2631")) {
    {}
  } else {
    stryCov_9fa48("2631");
    return new AgentCoreError(stryMutAct_9fa48("2632") ? "" : (stryCov_9fa48("2632"), "codec.invalid"), message);
  }
}
function hasExactKeys(value: object, keys: readonly string[]): boolean {
  if (stryMutAct_9fa48("2633")) {
    {}
  } else {
    stryCov_9fa48("2633");
    const actual = stryMutAct_9fa48("2634") ? Object.keys(value) : (stryCov_9fa48("2634"), Object.keys(value).sort());
    return stryMutAct_9fa48("2637") ? actual.length === keys.length || actual.every((key, index) => key === keys[index]) : stryMutAct_9fa48("2636") ? false : stryMutAct_9fa48("2635") ? true : (stryCov_9fa48("2635", "2636", "2637"), (stryMutAct_9fa48("2639") ? actual.length !== keys.length : stryMutAct_9fa48("2638") ? true : (stryCov_9fa48("2638", "2639"), actual.length === keys.length)) && (stryMutAct_9fa48("2640") ? actual.some((key, index) => key === keys[index]) : (stryCov_9fa48("2640"), actual.every(stryMutAct_9fa48("2641") ? () => undefined : (stryCov_9fa48("2641"), (key, index) => stryMutAct_9fa48("2644") ? key !== keys[index] : stryMutAct_9fa48("2643") ? false : stryMutAct_9fa48("2642") ? true : (stryCov_9fa48("2642", "2643", "2644"), key === keys[index]))))));
  }
}
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (stryMutAct_9fa48("2645")) {
    {}
  } else {
    stryCov_9fa48("2645");
    return (stryMutAct_9fa48("2648") ? typeof value === "object" && value !== null && typeof value === "function" : stryMutAct_9fa48("2647") ? false : stryMutAct_9fa48("2646") ? true : (stryCov_9fa48("2646", "2647", "2648"), (stryMutAct_9fa48("2650") ? typeof value === "object" || value !== null : stryMutAct_9fa48("2649") ? false : (stryCov_9fa48("2649", "2650"), (stryMutAct_9fa48("2652") ? typeof value !== "object" : stryMutAct_9fa48("2651") ? true : (stryCov_9fa48("2651", "2652"), typeof value === (stryMutAct_9fa48("2653") ? "" : (stryCov_9fa48("2653"), "object")))) && (stryMutAct_9fa48("2655") ? value === null : stryMutAct_9fa48("2654") ? true : (stryCov_9fa48("2654", "2655"), value !== null)))) || (stryMutAct_9fa48("2657") ? typeof value !== "function" : stryMutAct_9fa48("2656") ? false : (stryCov_9fa48("2656", "2657"), typeof value === (stryMutAct_9fa48("2658") ? "" : (stryCov_9fa48("2658"), "function")))))) ? (stryMutAct_9fa48("2659") ? "" : (stryCov_9fa48("2659"), "then")) in value : stryMutAct_9fa48("2660") ? true : (stryCov_9fa48("2660"), false);
  }
}