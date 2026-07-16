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
import { RecordCodec, type JsonValue, type RecordVersion } from "../core";
import { AgentCoreError } from "../errors";
import { CapabilitySpec, isCapabilityEffect, type CapabilityEffect } from "../facets";
import { MembershipId, type ScopeRef, type SubjectRef } from "../identity";
import { requireBoolean, requireExact, requireObject, requireSafeInteger, requireString, type JsonObject } from "./data";
import { GrantId } from "./id";
import { decodeAuthorityScope, decodeAuthoritySubject, encodeAuthorityScope, encodeAuthoritySubject, scopeKey, subjectKey } from "./reference";
export type GrantEffect = CapabilityEffect;
export type GrantOrigin = {
  readonly kind: "direct";
} | {
  readonly kind: "role";
  readonly membershipId: MembershipId;
  readonly roleName: string;
  readonly ruleOrdinal: number;
  readonly guest: boolean;
};
export interface GrantInit {
  readonly id: GrantId;
  readonly scope: ScopeRef;
  readonly subject: SubjectRef;
  readonly effect: GrantEffect;
  readonly capability: CapabilitySpec;
  readonly origin: GrantOrigin;
  readonly attenuationOf?: GrantId;
  readonly state?: GrantState;
}
export abstract class GrantState {
  public static get active(): GrantState {
    if (stryMutAct_9fa48("1231")) {
      {}
    } else {
      stryCov_9fa48("1231");
      return activeGrantState;
    }
  }
  public static get revoked(): GrantState {
    if (stryMutAct_9fa48("1232")) {
      {}
    } else {
      stryCov_9fa48("1232");
      return revokedGrantState;
    }
  }
  public abstract readonly name: "active" | "revoked";
  public abstract revoke(): GrantState;
  public get isActive(): boolean {
    if (stryMutAct_9fa48("1233")) {
      {}
    } else {
      stryCov_9fa48("1233");
      return stryMutAct_9fa48("1236") ? this.name !== "active" : stryMutAct_9fa48("1235") ? false : stryMutAct_9fa48("1234") ? true : (stryCov_9fa48("1234", "1235", "1236"), this.name === (stryMutAct_9fa48("1237") ? "" : (stryCov_9fa48("1237"), "active")));
    }
  }
}
class ActiveGrantState extends GrantState {
  public readonly name = stryMutAct_9fa48("1238") ? "" : (stryCov_9fa48("1238"), "active");
  public revoke(): GrantState {
    if (stryMutAct_9fa48("1239")) {
      {}
    } else {
      stryCov_9fa48("1239");
      return GrantState.revoked;
    }
  }
}
class RevokedGrantState extends GrantState {
  public readonly name = stryMutAct_9fa48("1240") ? "" : (stryCov_9fa48("1240"), "revoked");
  public revoke(): GrantState {
    if (stryMutAct_9fa48("1241")) {
      {}
    } else {
      stryCov_9fa48("1241");
      return this;
    }
  }
}
const activeGrantState = Object.freeze(new ActiveGrantState());
const revokedGrantState = Object.freeze(new RevokedGrantState());
class GrantCodecV1 extends RecordCodec<Grant> {
  public constructor() {
    if (stryMutAct_9fa48("1242")) {
      {}
    } else {
      stryCov_9fa48("1242");
      super(stryMutAct_9fa48("1243") ? "" : (stryCov_9fa48("1243"), "authority.grant"), stryMutAct_9fa48("1244") ? {} : (stryCov_9fa48("1244"), {
        major: 1,
        minor: 0
      }));
    }
  }
  protected encodePayload(grant: Grant): JsonValue {
    if (stryMutAct_9fa48("1245")) {
      {}
    } else {
      stryCov_9fa48("1245");
      return grant.toData();
    }
  }
  protected decodePayload(payload: JsonValue, _version: RecordVersion): Grant {
    if (stryMutAct_9fa48("1246")) {
      {}
    } else {
      stryCov_9fa48("1246");
      return Grant.fromData(payload);
    }
  }
}
export class Grant {
  public static readonly codec: RecordCodec<Grant> = new GrantCodecV1();
  public readonly state: GrantState;
  public readonly attenuationOf: GrantId | undefined;
  public readonly origin: GrantOrigin;
  public readonly subject: SubjectRef;
  public constructor(public readonly id: GrantId, public readonly scope: ScopeRef, subject: SubjectRef, public readonly effect: GrantEffect, public readonly capability: CapabilitySpec, origin: GrantOrigin, attenuationOf?: GrantId, state: GrantState = GrantState.active) {
    if (stryMutAct_9fa48("1247")) {
      {}
    } else {
      stryCov_9fa48("1247");
      if (stryMutAct_9fa48("1250") ? false : stryMutAct_9fa48("1249") ? true : stryMutAct_9fa48("1248") ? isCapabilityEffect(effect) : (stryCov_9fa48("1248", "1249", "1250"), !isCapabilityEffect(effect))) throw new TypeError(stryMutAct_9fa48("1251") ? "" : (stryCov_9fa48("1251"), "Grant effect is invalid"));
      if (stryMutAct_9fa48("1254") ? effect === "deny" || attenuationOf !== undefined : stryMutAct_9fa48("1253") ? false : stryMutAct_9fa48("1252") ? true : (stryCov_9fa48("1252", "1253", "1254"), (stryMutAct_9fa48("1256") ? effect !== "deny" : stryMutAct_9fa48("1255") ? true : (stryCov_9fa48("1255", "1256"), effect === (stryMutAct_9fa48("1257") ? "" : (stryCov_9fa48("1257"), "deny")))) && (stryMutAct_9fa48("1259") ? attenuationOf === undefined : stryMutAct_9fa48("1258") ? true : (stryCov_9fa48("1258", "1259"), attenuationOf !== undefined)))) {
        if (stryMutAct_9fa48("1260")) {
          {}
        } else {
          stryCov_9fa48("1260");
          throw new TypeError(stryMutAct_9fa48("1261") ? "" : (stryCov_9fa48("1261"), "Deny Grants cannot be attenuated or delegated"));
        }
      }
      validateOrigin(origin);
      this.subject = decodeAuthoritySubject(encodeAuthoritySubject(subject));
      this.origin = Object.freeze(stryMutAct_9fa48("1262") ? {} : (stryCov_9fa48("1262"), {
        ...origin
      }));
      this.attenuationOf = attenuationOf;
      this.state = state;
      Object.freeze(this);
    }
  }
  public static create(init: GrantInit): Grant {
    if (stryMutAct_9fa48("1263")) {
      {}
    } else {
      stryCov_9fa48("1263");
      return new Grant(init.id, init.scope, init.subject, init.effect, init.capability, init.origin, init.attenuationOf, init.state);
    }
  }
  public static encode(grant: Grant): Uint8Array {
    if (stryMutAct_9fa48("1264")) {
      {}
    } else {
      stryCov_9fa48("1264");
      return Grant.codec.encode(grant);
    }
  }
  public static decode(bytes: Uint8Array): Grant {
    if (stryMutAct_9fa48("1265")) {
      {}
    } else {
      stryCov_9fa48("1265");
      return Grant.codec.decode(bytes);
    }
  }
  public get isLive(): boolean {
    if (stryMutAct_9fa48("1266")) {
      {}
    } else {
      stryCov_9fa48("1266");
      return this.state.isActive;
    }
  }
  public revoke(): Grant {
    if (stryMutAct_9fa48("1267")) {
      {}
    } else {
      stryCov_9fa48("1267");
      return new Grant(this.id, this.scope, this.subject, this.effect, this.capability, this.origin, this.attenuationOf, this.state.revoke());
    }
  }
  public canAttenuate(child: Grant): boolean {
    if (stryMutAct_9fa48("1268")) {
      {}
    } else {
      stryCov_9fa48("1268");
      return stryMutAct_9fa48("1271") ? this.effect === "allow" && (!child.isLive || this.isLive) && this.capability.covers(child.capability) && child.scope.path.some(scope => scope.equals(this.scope)) || this.scope.path.length <= child.scope.path.length : stryMutAct_9fa48("1270") ? false : stryMutAct_9fa48("1269") ? true : (stryCov_9fa48("1269", "1270", "1271"), (stryMutAct_9fa48("1273") ? this.effect === "allow" && (!child.isLive || this.isLive) && this.capability.covers(child.capability) || child.scope.path.some(scope => scope.equals(this.scope)) : stryMutAct_9fa48("1272") ? true : (stryCov_9fa48("1272", "1273"), (stryMutAct_9fa48("1275") ? this.effect === "allow" && (!child.isLive || this.isLive) || this.capability.covers(child.capability) : stryMutAct_9fa48("1274") ? true : (stryCov_9fa48("1274", "1275"), (stryMutAct_9fa48("1277") ? this.effect === "allow" || !child.isLive || this.isLive : stryMutAct_9fa48("1276") ? true : (stryCov_9fa48("1276", "1277"), (stryMutAct_9fa48("1279") ? this.effect !== "allow" : stryMutAct_9fa48("1278") ? true : (stryCov_9fa48("1278", "1279"), this.effect === (stryMutAct_9fa48("1280") ? "" : (stryCov_9fa48("1280"), "allow")))) && (stryMutAct_9fa48("1282") ? !child.isLive && this.isLive : stryMutAct_9fa48("1281") ? true : (stryCov_9fa48("1281", "1282"), (stryMutAct_9fa48("1283") ? child.isLive : (stryCov_9fa48("1283"), !child.isLive)) || this.isLive)))) && this.capability.covers(child.capability))) && (stryMutAct_9fa48("1284") ? child.scope.path.every(scope => scope.equals(this.scope)) : (stryCov_9fa48("1284"), child.scope.path.some(stryMutAct_9fa48("1285") ? () => undefined : (stryCov_9fa48("1285"), scope => scope.equals(this.scope))))))) && (stryMutAct_9fa48("1288") ? this.scope.path.length > child.scope.path.length : stryMutAct_9fa48("1287") ? this.scope.path.length < child.scope.path.length : stryMutAct_9fa48("1286") ? true : (stryCov_9fa48("1286", "1287", "1288"), this.scope.path.length <= child.scope.path.length)));
    }
  }
  public assertCanReplace(next: Grant): void {
    if (stryMutAct_9fa48("1289")) {
      {}
    } else {
      stryCov_9fa48("1289");
      if (stryMutAct_9fa48("1292") ? (scopeKey(this.scope) !== scopeKey(next.scope) || subjectKey(this.subject) !== subjectKey(next.subject) || this.attenuationOf?.value !== next.attenuationOf?.value) && !sameOriginIdentity(this.origin, next.origin) : stryMutAct_9fa48("1291") ? false : stryMutAct_9fa48("1290") ? true : (stryCov_9fa48("1290", "1291", "1292"), (stryMutAct_9fa48("1294") ? (scopeKey(this.scope) !== scopeKey(next.scope) || subjectKey(this.subject) !== subjectKey(next.subject)) && this.attenuationOf?.value !== next.attenuationOf?.value : stryMutAct_9fa48("1293") ? false : (stryCov_9fa48("1293", "1294"), (stryMutAct_9fa48("1296") ? scopeKey(this.scope) !== scopeKey(next.scope) && subjectKey(this.subject) !== subjectKey(next.subject) : stryMutAct_9fa48("1295") ? false : (stryCov_9fa48("1295", "1296"), (stryMutAct_9fa48("1298") ? scopeKey(this.scope) === scopeKey(next.scope) : stryMutAct_9fa48("1297") ? false : (stryCov_9fa48("1297", "1298"), scopeKey(this.scope) !== scopeKey(next.scope))) || (stryMutAct_9fa48("1300") ? subjectKey(this.subject) === subjectKey(next.subject) : stryMutAct_9fa48("1299") ? false : (stryCov_9fa48("1299", "1300"), subjectKey(this.subject) !== subjectKey(next.subject))))) || (stryMutAct_9fa48("1302") ? this.attenuationOf?.value === next.attenuationOf?.value : stryMutAct_9fa48("1301") ? false : (stryCov_9fa48("1301", "1302"), (stryMutAct_9fa48("1303") ? this.attenuationOf.value : (stryCov_9fa48("1303"), this.attenuationOf?.value)) !== (stryMutAct_9fa48("1304") ? next.attenuationOf.value : (stryCov_9fa48("1304"), next.attenuationOf?.value)))))) || (stryMutAct_9fa48("1305") ? sameOriginIdentity(this.origin, next.origin) : (stryCov_9fa48("1305"), !sameOriginIdentity(this.origin, next.origin))))) {
        if (stryMutAct_9fa48("1306")) {
          {}
        } else {
          stryCov_9fa48("1306");
          throw new AgentCoreError(stryMutAct_9fa48("1307") ? "" : (stryCov_9fa48("1307"), "protocol.invalid-state"), stryMutAct_9fa48("1308") ? "" : (stryCov_9fa48("1308"), "Grant subject, Scope, origin, and attenuation lineage are immutable"));
        }
      }
      if (stryMutAct_9fa48("1311") ? !this.isLive || next.isLive : stryMutAct_9fa48("1310") ? false : stryMutAct_9fa48("1309") ? true : (stryCov_9fa48("1309", "1310", "1311"), (stryMutAct_9fa48("1312") ? this.isLive : (stryCov_9fa48("1312"), !this.isLive)) && next.isLive)) {
        if (stryMutAct_9fa48("1313")) {
          {}
        } else {
          stryCov_9fa48("1313");
          throw new AgentCoreError(stryMutAct_9fa48("1314") ? "" : (stryCov_9fa48("1314"), "protocol.invalid-state"), stryMutAct_9fa48("1315") ? "" : (stryCov_9fa48("1315"), "Revoked Grants cannot reactivate"));
        }
      }
      if (stryMutAct_9fa48("1318") ? this.origin.kind === "direct" || !bytesEqual(Grant.encode(this.revoke()), Grant.encode(next)) : stryMutAct_9fa48("1317") ? false : stryMutAct_9fa48("1316") ? true : (stryCov_9fa48("1316", "1317", "1318"), (stryMutAct_9fa48("1320") ? this.origin.kind !== "direct" : stryMutAct_9fa48("1319") ? true : (stryCov_9fa48("1319", "1320"), this.origin.kind === (stryMutAct_9fa48("1321") ? "" : (stryCov_9fa48("1321"), "direct")))) && (stryMutAct_9fa48("1322") ? bytesEqual(Grant.encode(this.revoke()), Grant.encode(next)) : (stryCov_9fa48("1322"), !bytesEqual(Grant.encode(this.revoke()), Grant.encode(next)))))) {
        if (stryMutAct_9fa48("1323")) {
          {}
        } else {
          stryCov_9fa48("1323");
          throw new AgentCoreError(stryMutAct_9fa48("1324") ? "" : (stryCov_9fa48("1324"), "protocol.invalid-state"), stryMutAct_9fa48("1325") ? "" : (stryCov_9fa48("1325"), "Direct Grants are immutable except for revocation"));
        }
      }
    }
  }
  public toData(): JsonObject {
    if (stryMutAct_9fa48("1326")) {
      {}
    } else {
      stryCov_9fa48("1326");
      return stryMutAct_9fa48("1327") ? {} : (stryCov_9fa48("1327"), {
        attenuationOf: stryMutAct_9fa48("1328") ? this.attenuationOf?.value && null : (stryCov_9fa48("1328"), (stryMutAct_9fa48("1329") ? this.attenuationOf.value : (stryCov_9fa48("1329"), this.attenuationOf?.value)) ?? null),
        capability: this.capability.toData(),
        effect: this.effect,
        id: this.id.value,
        origin: encodeOrigin(this.origin),
        scope: encodeAuthorityScope(this.scope),
        state: this.state.name,
        subject: encodeAuthoritySubject(this.subject)
      });
    }
  }
  public static fromData(value: JsonValue | undefined): Grant {
    if (stryMutAct_9fa48("1330")) {
      {}
    } else {
      stryCov_9fa48("1330");
      const object = requireObject(value, stryMutAct_9fa48("1331") ? "" : (stryCov_9fa48("1331"), "Grant"));
      requireExact(object, stryMutAct_9fa48("1332") ? [] : (stryCov_9fa48("1332"), [stryMutAct_9fa48("1333") ? "" : (stryCov_9fa48("1333"), "attenuationOf"), stryMutAct_9fa48("1334") ? "" : (stryCov_9fa48("1334"), "capability"), stryMutAct_9fa48("1335") ? "" : (stryCov_9fa48("1335"), "effect"), stryMutAct_9fa48("1336") ? "" : (stryCov_9fa48("1336"), "id"), stryMutAct_9fa48("1337") ? "" : (stryCov_9fa48("1337"), "origin"), stryMutAct_9fa48("1338") ? "" : (stryCov_9fa48("1338"), "scope"), stryMutAct_9fa48("1339") ? "" : (stryCov_9fa48("1339"), "state"), stryMutAct_9fa48("1340") ? "" : (stryCov_9fa48("1340"), "subject")]), stryMutAct_9fa48("1341") ? "" : (stryCov_9fa48("1341"), "Grant"));
      const attenuation = object[stryMutAct_9fa48("1342") ? "" : (stryCov_9fa48("1342"), "attenuationOf")];
      if (stryMutAct_9fa48("1345") ? attenuation !== null || typeof attenuation !== "string" : stryMutAct_9fa48("1344") ? false : stryMutAct_9fa48("1343") ? true : (stryCov_9fa48("1343", "1344", "1345"), (stryMutAct_9fa48("1347") ? attenuation === null : stryMutAct_9fa48("1346") ? true : (stryCov_9fa48("1346", "1347"), attenuation !== null)) && (stryMutAct_9fa48("1349") ? typeof attenuation === "string" : stryMutAct_9fa48("1348") ? true : (stryCov_9fa48("1348", "1349"), typeof attenuation !== (stryMutAct_9fa48("1350") ? "" : (stryCov_9fa48("1350"), "string")))))) {
        if (stryMutAct_9fa48("1351")) {
          {}
        } else {
          stryCov_9fa48("1351");
          throw new TypeError(stryMutAct_9fa48("1352") ? "" : (stryCov_9fa48("1352"), "Grant attenuation parent must be a string or null"));
        }
      }
      return new Grant(new GrantId(requireString(object, stryMutAct_9fa48("1353") ? "" : (stryCov_9fa48("1353"), "id"), stryMutAct_9fa48("1354") ? "" : (stryCov_9fa48("1354"), "Grant ID"))), decodeAuthorityScope(object[stryMutAct_9fa48("1355") ? "" : (stryCov_9fa48("1355"), "scope")]!), decodeAuthoritySubject(object[stryMutAct_9fa48("1356") ? "" : (stryCov_9fa48("1356"), "subject")]!), requireEffect(object[stryMutAct_9fa48("1357") ? "" : (stryCov_9fa48("1357"), "effect")]), CapabilitySpec.fromData(object[stryMutAct_9fa48("1358") ? "" : (stryCov_9fa48("1358"), "capability")]), decodeOrigin(object[stryMutAct_9fa48("1359") ? "" : (stryCov_9fa48("1359"), "origin")]), (stryMutAct_9fa48("1362") ? attenuation !== null : stryMutAct_9fa48("1361") ? false : stryMutAct_9fa48("1360") ? true : (stryCov_9fa48("1360", "1361", "1362"), attenuation === null)) ? undefined : new GrantId(attenuation), requireState(object[stryMutAct_9fa48("1363") ? "" : (stryCov_9fa48("1363"), "state")]));
    }
  }
}
function encodeOrigin(origin: GrantOrigin): JsonObject {
  if (stryMutAct_9fa48("1364")) {
    {}
  } else {
    stryCov_9fa48("1364");
    return (stryMutAct_9fa48("1367") ? origin.kind !== "direct" : stryMutAct_9fa48("1366") ? false : stryMutAct_9fa48("1365") ? true : (stryCov_9fa48("1365", "1366", "1367"), origin.kind === (stryMutAct_9fa48("1368") ? "" : (stryCov_9fa48("1368"), "direct")))) ? stryMutAct_9fa48("1369") ? {} : (stryCov_9fa48("1369"), {
      kind: origin.kind
    }) : stryMutAct_9fa48("1370") ? {} : (stryCov_9fa48("1370"), {
      guest: origin.guest,
      kind: origin.kind,
      membershipId: origin.membershipId.value,
      roleName: origin.roleName,
      ruleOrdinal: origin.ruleOrdinal
    });
  }
}
function decodeOrigin(value: JsonValue | undefined): GrantOrigin {
  if (stryMutAct_9fa48("1371")) {
    {}
  } else {
    stryCov_9fa48("1371");
    const object = requireObject(value, stryMutAct_9fa48("1372") ? "" : (stryCov_9fa48("1372"), "Grant origin"));
    const kind = requireString(object, stryMutAct_9fa48("1373") ? "" : (stryCov_9fa48("1373"), "kind"), stryMutAct_9fa48("1374") ? "" : (stryCov_9fa48("1374"), "Grant origin kind"));
    if (stryMutAct_9fa48("1377") ? kind !== "direct" : stryMutAct_9fa48("1376") ? false : stryMutAct_9fa48("1375") ? true : (stryCov_9fa48("1375", "1376", "1377"), kind === (stryMutAct_9fa48("1378") ? "" : (stryCov_9fa48("1378"), "direct")))) {
      if (stryMutAct_9fa48("1379")) {
        {}
      } else {
        stryCov_9fa48("1379");
        requireExact(object, stryMutAct_9fa48("1380") ? [] : (stryCov_9fa48("1380"), [stryMutAct_9fa48("1381") ? "" : (stryCov_9fa48("1381"), "kind")]), stryMutAct_9fa48("1382") ? "" : (stryCov_9fa48("1382"), "Direct Grant origin"));
        return stryMutAct_9fa48("1383") ? {} : (stryCov_9fa48("1383"), {
          kind
        });
      }
    }
    if (stryMutAct_9fa48("1386") ? kind !== "role" : stryMutAct_9fa48("1385") ? false : stryMutAct_9fa48("1384") ? true : (stryCov_9fa48("1384", "1385", "1386"), kind === (stryMutAct_9fa48("1387") ? "" : (stryCov_9fa48("1387"), "role")))) {
      if (stryMutAct_9fa48("1388")) {
        {}
      } else {
        stryCov_9fa48("1388");
        requireExact(object, stryMutAct_9fa48("1389") ? [] : (stryCov_9fa48("1389"), [stryMutAct_9fa48("1390") ? "" : (stryCov_9fa48("1390"), "guest"), stryMutAct_9fa48("1391") ? "" : (stryCov_9fa48("1391"), "kind"), stryMutAct_9fa48("1392") ? "" : (stryCov_9fa48("1392"), "membershipId"), stryMutAct_9fa48("1393") ? "" : (stryCov_9fa48("1393"), "roleName"), stryMutAct_9fa48("1394") ? "" : (stryCov_9fa48("1394"), "ruleOrdinal")]), stryMutAct_9fa48("1395") ? "" : (stryCov_9fa48("1395"), "Role Grant origin"));
        return stryMutAct_9fa48("1396") ? {} : (stryCov_9fa48("1396"), {
          kind,
          membershipId: new MembershipId(requireString(object, stryMutAct_9fa48("1397") ? "" : (stryCov_9fa48("1397"), "membershipId"), stryMutAct_9fa48("1398") ? "" : (stryCov_9fa48("1398"), "Membership ID"))),
          roleName: requireString(object, stryMutAct_9fa48("1399") ? "" : (stryCov_9fa48("1399"), "roleName"), stryMutAct_9fa48("1400") ? "" : (stryCov_9fa48("1400"), "Role name")),
          ruleOrdinal: requireSafeInteger(object, stryMutAct_9fa48("1401") ? "" : (stryCov_9fa48("1401"), "ruleOrdinal"), stryMutAct_9fa48("1402") ? "" : (stryCov_9fa48("1402"), "Role rule ordinal")),
          guest: requireBoolean(object, stryMutAct_9fa48("1403") ? "" : (stryCov_9fa48("1403"), "guest"), stryMutAct_9fa48("1404") ? "" : (stryCov_9fa48("1404"), "Role guest flag"))
        });
      }
    }
    throw new TypeError(stryMutAct_9fa48("1405") ? "" : (stryCov_9fa48("1405"), "Grant origin kind is invalid"));
  }
}
function validateOrigin(origin: GrantOrigin): void {
  if (stryMutAct_9fa48("1406")) {
    {}
  } else {
    stryCov_9fa48("1406");
    if (stryMutAct_9fa48("1409") ? origin.kind !== "direct" : stryMutAct_9fa48("1408") ? false : stryMutAct_9fa48("1407") ? true : (stryCov_9fa48("1407", "1408", "1409"), origin.kind === (stryMutAct_9fa48("1410") ? "" : (stryCov_9fa48("1410"), "direct")))) return;
    if (stryMutAct_9fa48("1413") ? (!(origin.membershipId instanceof MembershipId) || origin.roleName.length === 0 || origin.roleName.length > 256 || !Number.isSafeInteger(origin.ruleOrdinal)) && origin.ruleOrdinal < 0 : stryMutAct_9fa48("1412") ? false : stryMutAct_9fa48("1411") ? true : (stryCov_9fa48("1411", "1412", "1413"), (stryMutAct_9fa48("1415") ? (!(origin.membershipId instanceof MembershipId) || origin.roleName.length === 0 || origin.roleName.length > 256) && !Number.isSafeInteger(origin.ruleOrdinal) : stryMutAct_9fa48("1414") ? false : (stryCov_9fa48("1414", "1415"), (stryMutAct_9fa48("1417") ? (!(origin.membershipId instanceof MembershipId) || origin.roleName.length === 0) && origin.roleName.length > 256 : stryMutAct_9fa48("1416") ? false : (stryCov_9fa48("1416", "1417"), (stryMutAct_9fa48("1419") ? !(origin.membershipId instanceof MembershipId) && origin.roleName.length === 0 : stryMutAct_9fa48("1418") ? false : (stryCov_9fa48("1418", "1419"), (stryMutAct_9fa48("1420") ? origin.membershipId instanceof MembershipId : (stryCov_9fa48("1420"), !(origin.membershipId instanceof MembershipId))) || (stryMutAct_9fa48("1422") ? origin.roleName.length !== 0 : stryMutAct_9fa48("1421") ? false : (stryCov_9fa48("1421", "1422"), origin.roleName.length === 0)))) || (stryMutAct_9fa48("1425") ? origin.roleName.length <= 256 : stryMutAct_9fa48("1424") ? origin.roleName.length >= 256 : stryMutAct_9fa48("1423") ? false : (stryCov_9fa48("1423", "1424", "1425"), origin.roleName.length > 256)))) || (stryMutAct_9fa48("1426") ? Number.isSafeInteger(origin.ruleOrdinal) : (stryCov_9fa48("1426"), !Number.isSafeInteger(origin.ruleOrdinal))))) || (stryMutAct_9fa48("1429") ? origin.ruleOrdinal >= 0 : stryMutAct_9fa48("1428") ? origin.ruleOrdinal <= 0 : stryMutAct_9fa48("1427") ? false : (stryCov_9fa48("1427", "1428", "1429"), origin.ruleOrdinal < 0)))) {
      if (stryMutAct_9fa48("1430")) {
        {}
      } else {
        stryCov_9fa48("1430");
        throw new TypeError(stryMutAct_9fa48("1431") ? "" : (stryCov_9fa48("1431"), "Role Grant origin is invalid"));
      }
    }
  }
}
function sameOriginIdentity(left: GrantOrigin, right: GrantOrigin): boolean {
  if (stryMutAct_9fa48("1432")) {
    {}
  } else {
    stryCov_9fa48("1432");
    if (stryMutAct_9fa48("1435") ? left.kind === right.kind : stryMutAct_9fa48("1434") ? false : stryMutAct_9fa48("1433") ? true : (stryCov_9fa48("1433", "1434", "1435"), left.kind !== right.kind)) return stryMutAct_9fa48("1436") ? true : (stryCov_9fa48("1436"), false);
    if (stryMutAct_9fa48("1439") ? left.kind === "direct" && right.kind === "direct" : stryMutAct_9fa48("1438") ? false : stryMutAct_9fa48("1437") ? true : (stryCov_9fa48("1437", "1438", "1439"), (stryMutAct_9fa48("1441") ? left.kind !== "direct" : stryMutAct_9fa48("1440") ? false : (stryCov_9fa48("1440", "1441"), left.kind === (stryMutAct_9fa48("1442") ? "" : (stryCov_9fa48("1442"), "direct")))) || (stryMutAct_9fa48("1444") ? right.kind !== "direct" : stryMutAct_9fa48("1443") ? false : (stryCov_9fa48("1443", "1444"), right.kind === (stryMutAct_9fa48("1445") ? "" : (stryCov_9fa48("1445"), "direct")))))) return stryMutAct_9fa48("1446") ? false : (stryCov_9fa48("1446"), true);
    return stryMutAct_9fa48("1449") ? left.membershipId.equals(right.membershipId) && left.ruleOrdinal === right.ruleOrdinal || left.guest === right.guest : stryMutAct_9fa48("1448") ? false : stryMutAct_9fa48("1447") ? true : (stryCov_9fa48("1447", "1448", "1449"), (stryMutAct_9fa48("1451") ? left.membershipId.equals(right.membershipId) || left.ruleOrdinal === right.ruleOrdinal : stryMutAct_9fa48("1450") ? true : (stryCov_9fa48("1450", "1451"), left.membershipId.equals(right.membershipId) && (stryMutAct_9fa48("1453") ? left.ruleOrdinal !== right.ruleOrdinal : stryMutAct_9fa48("1452") ? true : (stryCov_9fa48("1452", "1453"), left.ruleOrdinal === right.ruleOrdinal)))) && (stryMutAct_9fa48("1455") ? left.guest !== right.guest : stryMutAct_9fa48("1454") ? true : (stryCov_9fa48("1454", "1455"), left.guest === right.guest)));
  }
}
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (stryMutAct_9fa48("1456")) {
    {}
  } else {
    stryCov_9fa48("1456");
    return stryMutAct_9fa48("1459") ? left.byteLength === right.byteLength || left.every((value, index) => value === right[index]) : stryMutAct_9fa48("1458") ? false : stryMutAct_9fa48("1457") ? true : (stryCov_9fa48("1457", "1458", "1459"), (stryMutAct_9fa48("1461") ? left.byteLength !== right.byteLength : stryMutAct_9fa48("1460") ? true : (stryCov_9fa48("1460", "1461"), left.byteLength === right.byteLength)) && (stryMutAct_9fa48("1462") ? left.some((value, index) => value === right[index]) : (stryCov_9fa48("1462"), left.every(stryMutAct_9fa48("1463") ? () => undefined : (stryCov_9fa48("1463"), (value, index) => stryMutAct_9fa48("1466") ? value !== right[index] : stryMutAct_9fa48("1465") ? false : stryMutAct_9fa48("1464") ? true : (stryCov_9fa48("1464", "1465", "1466"), value === right[index]))))));
  }
}
function requireEffect(value: JsonValue | undefined): GrantEffect {
  if (stryMutAct_9fa48("1467")) {
    {}
  } else {
    stryCov_9fa48("1467");
    if (stryMutAct_9fa48("1469") ? false : stryMutAct_9fa48("1468") ? true : (stryCov_9fa48("1468", "1469"), isCapabilityEffect(value))) return value;
    throw new TypeError(stryMutAct_9fa48("1470") ? "" : (stryCov_9fa48("1470"), "Grant effect is invalid"));
  }
}
function requireState(value: JsonValue | undefined): GrantState {
  if (stryMutAct_9fa48("1471")) {
    {}
  } else {
    stryCov_9fa48("1471");
    if (stryMutAct_9fa48("1474") ? value !== "active" : stryMutAct_9fa48("1473") ? false : stryMutAct_9fa48("1472") ? true : (stryCov_9fa48("1472", "1473", "1474"), value === (stryMutAct_9fa48("1475") ? "" : (stryCov_9fa48("1475"), "active")))) return GrantState.active;
    if (stryMutAct_9fa48("1478") ? value !== "revoked" : stryMutAct_9fa48("1477") ? false : stryMutAct_9fa48("1476") ? true : (stryCov_9fa48("1476", "1477", "1478"), value === (stryMutAct_9fa48("1479") ? "" : (stryCov_9fa48("1479"), "revoked")))) return GrantState.revoked;
    throw new TypeError(stryMutAct_9fa48("1480") ? "" : (stryCov_9fa48("1480"), "Grant state is invalid"));
  }
}