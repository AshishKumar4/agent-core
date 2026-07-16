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
import { ActorId, ActorRef, type ActorKind } from "../actors";
import { RecordCodec, Revision, type JsonValue, type RecordVersion } from "../core";
import { AgentCoreError } from "../errors";
import { PrincipalId, PrincipalRef, TenantId, type ScopeRef } from "../identity";
import { requireArray, requireExact, requireObject, requireSafeInteger, requireString, type JsonObject } from "./data";
import { decodeAuthorityScope, encodeAuthorityScope, scopeKey } from "./reference";
class ScopeEpochCodecV1 extends RecordCodec<ScopeEpoch> {
  public constructor() {
    if (stryMutAct_9fa48("555")) {
      {}
    } else {
      stryCov_9fa48("555");
      super(stryMutAct_9fa48("556") ? "" : (stryCov_9fa48("556"), "authority.scope-epoch"), stryMutAct_9fa48("557") ? {} : (stryCov_9fa48("557"), {
        major: 1,
        minor: 0
      }));
    }
  }
  protected encodePayload(record: ScopeEpoch): JsonValue {
    if (stryMutAct_9fa48("558")) {
      {}
    } else {
      stryCov_9fa48("558");
      return record.toData();
    }
  }
  protected decodePayload(payload: JsonValue, _version: RecordVersion): ScopeEpoch {
    if (stryMutAct_9fa48("559")) {
      {}
    } else {
      stryCov_9fa48("559");
      return ScopeEpoch.fromData(payload);
    }
  }
}
class PathEpochEvidenceCodecV1 extends RecordCodec<PathEpochEvidence> {
  public constructor() {
    if (stryMutAct_9fa48("560")) {
      {}
    } else {
      stryCov_9fa48("560");
      super(stryMutAct_9fa48("561") ? "" : (stryCov_9fa48("561"), "authority.path-epoch-evidence"), stryMutAct_9fa48("562") ? {} : (stryCov_9fa48("562"), {
        major: 1,
        minor: 0
      }));
    }
  }
  protected encodePayload(record: PathEpochEvidence): JsonValue {
    if (stryMutAct_9fa48("563")) {
      {}
    } else {
      stryCov_9fa48("563");
      return record.toData();
    }
  }
  protected decodePayload(payload: JsonValue): PathEpochEvidence {
    if (stryMutAct_9fa48("564")) {
      {}
    } else {
      stryCov_9fa48("564");
      return PathEpochEvidence.fromData(payload);
    }
  }
}
class InvalidationWatermarkCodecV1 extends RecordCodec<InvalidationWatermark> {
  public constructor() {
    if (stryMutAct_9fa48("565")) {
      {}
    } else {
      stryCov_9fa48("565");
      super(stryMutAct_9fa48("566") ? "" : (stryCov_9fa48("566"), "authority.invalidation-watermark"), stryMutAct_9fa48("567") ? {} : (stryCov_9fa48("567"), {
        major: 1,
        minor: 0
      }));
    }
  }
  protected encodePayload(record: InvalidationWatermark): JsonValue {
    if (stryMutAct_9fa48("568")) {
      {}
    } else {
      stryCov_9fa48("568");
      return record.toData();
    }
  }
  protected decodePayload(payload: JsonValue): InvalidationWatermark {
    if (stryMutAct_9fa48("569")) {
      {}
    } else {
      stryCov_9fa48("569");
      return InvalidationWatermark.fromData(payload);
    }
  }
}
export class ScopeEpoch {
  public static readonly codec: RecordCodec<ScopeEpoch> = new ScopeEpochCodecV1();
  public constructor(public readonly scope: ScopeRef, public readonly epoch: number) {
    if (stryMutAct_9fa48("570")) {
      {}
    } else {
      stryCov_9fa48("570");
      if (stryMutAct_9fa48("573") ? !Number.isSafeInteger(epoch) && epoch < 0 : stryMutAct_9fa48("572") ? false : stryMutAct_9fa48("571") ? true : (stryCov_9fa48("571", "572", "573"), (stryMutAct_9fa48("574") ? Number.isSafeInteger(epoch) : (stryCov_9fa48("574"), !Number.isSafeInteger(epoch))) || (stryMutAct_9fa48("577") ? epoch >= 0 : stryMutAct_9fa48("576") ? epoch <= 0 : stryMutAct_9fa48("575") ? false : (stryCov_9fa48("575", "576", "577"), epoch < 0)))) {
        if (stryMutAct_9fa48("578")) {
          {}
        } else {
          stryCov_9fa48("578");
          throw new TypeError(stryMutAct_9fa48("579") ? "" : (stryCov_9fa48("579"), "Scope epoch must be a non-negative safe integer"));
        }
      }
      Object.freeze(this);
    }
  }
  public static initial(scope: ScopeRef): ScopeEpoch {
    if (stryMutAct_9fa48("580")) {
      {}
    } else {
      stryCov_9fa48("580");
      return new ScopeEpoch(scope, 0);
    }
  }
  public static encode(record: ScopeEpoch): Uint8Array {
    if (stryMutAct_9fa48("581")) {
      {}
    } else {
      stryCov_9fa48("581");
      return ScopeEpoch.codec.encode(record);
    }
  }
  public static decode(bytes: Uint8Array): ScopeEpoch {
    if (stryMutAct_9fa48("582")) {
      {}
    } else {
      stryCov_9fa48("582");
      return ScopeEpoch.codec.decode(bytes);
    }
  }
  public next(): ScopeEpoch {
    if (stryMutAct_9fa48("583")) {
      {}
    } else {
      stryCov_9fa48("583");
      if (stryMutAct_9fa48("586") ? this.epoch !== Number.MAX_SAFE_INTEGER : stryMutAct_9fa48("585") ? false : stryMutAct_9fa48("584") ? true : (stryCov_9fa48("584", "585", "586"), this.epoch === Number.MAX_SAFE_INTEGER)) {
        if (stryMutAct_9fa48("587")) {
          {}
        } else {
          stryCov_9fa48("587");
          throw new AgentCoreError(stryMutAct_9fa48("588") ? "" : (stryCov_9fa48("588"), "protocol.invalid-state"), stryMutAct_9fa48("589") ? `` : (stryCov_9fa48("589"), `Authority epoch is exhausted for ${scopeKey(this.scope)}`));
        }
      }
      return new ScopeEpoch(this.scope, stryMutAct_9fa48("590") ? this.epoch - 1 : (stryCov_9fa48("590"), this.epoch + 1));
    }
  }
  public equals(other: ScopeEpoch): boolean {
    if (stryMutAct_9fa48("591")) {
      {}
    } else {
      stryCov_9fa48("591");
      return stryMutAct_9fa48("594") ? scopeKey(this.scope) === scopeKey(other.scope) || this.epoch === other.epoch : stryMutAct_9fa48("593") ? false : stryMutAct_9fa48("592") ? true : (stryCov_9fa48("592", "593", "594"), (stryMutAct_9fa48("596") ? scopeKey(this.scope) !== scopeKey(other.scope) : stryMutAct_9fa48("595") ? true : (stryCov_9fa48("595", "596"), scopeKey(this.scope) === scopeKey(other.scope))) && (stryMutAct_9fa48("598") ? this.epoch !== other.epoch : stryMutAct_9fa48("597") ? true : (stryCov_9fa48("597", "598"), this.epoch === other.epoch)));
    }
  }
  public toData(): JsonObject {
    if (stryMutAct_9fa48("599")) {
      {}
    } else {
      stryCov_9fa48("599");
      return stryMutAct_9fa48("600") ? {} : (stryCov_9fa48("600"), {
        epoch: this.epoch,
        scope: encodeAuthorityScope(this.scope)
      });
    }
  }
  public static fromData(value: JsonValue | undefined): ScopeEpoch {
    if (stryMutAct_9fa48("601")) {
      {}
    } else {
      stryCov_9fa48("601");
      const object = requireObject(value, stryMutAct_9fa48("602") ? "" : (stryCov_9fa48("602"), "Scope epoch"));
      requireExact(object, stryMutAct_9fa48("603") ? [] : (stryCov_9fa48("603"), [stryMutAct_9fa48("604") ? "" : (stryCov_9fa48("604"), "epoch"), stryMutAct_9fa48("605") ? "" : (stryCov_9fa48("605"), "scope")]), stryMutAct_9fa48("606") ? "" : (stryCov_9fa48("606"), "Scope epoch"));
      return new ScopeEpoch(decodeAuthorityScope(object[stryMutAct_9fa48("607") ? "" : (stryCov_9fa48("607"), "scope")]!), requireSafeInteger(object, stryMutAct_9fa48("608") ? "" : (stryCov_9fa48("608"), "epoch"), stryMutAct_9fa48("609") ? "" : (stryCov_9fa48("609"), "Scope epoch")));
    }
  }
}
export class PathEpochEvidence {
  public static readonly codec: RecordCodec<PathEpochEvidence> = new PathEpochEvidenceCodecV1();
  public readonly path: readonly [ScopeEpoch, ...ScopeEpoch[]];
  public constructor(path: readonly [ScopeEpoch, ...ScopeEpoch[]]) {
    if (stryMutAct_9fa48("610")) {
      {}
    } else {
      stryCov_9fa48("610");
      validatePath(path);
      this.path = Object.freeze([...path]) as unknown as readonly [ScopeEpoch, ...ScopeEpoch[]];
      Object.freeze(this);
    }
  }
  public static encode(record: PathEpochEvidence): Uint8Array {
    if (stryMutAct_9fa48("611")) {
      {}
    } else {
      stryCov_9fa48("611");
      return PathEpochEvidence.codec.encode(record);
    }
  }
  public static decode(bytes: Uint8Array): PathEpochEvidence {
    if (stryMutAct_9fa48("612")) {
      {}
    } else {
      stryCov_9fa48("612");
      return PathEpochEvidence.codec.decode(bytes);
    }
  }
  public get target(): ScopeEpoch {
    if (stryMutAct_9fa48("613")) {
      {}
    } else {
      stryCov_9fa48("613");
      return this.path[stryMutAct_9fa48("614") ? this.path.length + 1 : (stryCov_9fa48("614"), this.path.length - 1)]!;
    }
  }
  public equals(other: PathEpochEvidence): boolean {
    if (stryMutAct_9fa48("615")) {
      {}
    } else {
      stryCov_9fa48("615");
      return stryMutAct_9fa48("618") ? this.path.length === other.path.length || this.path.every((entry, index) => entry.equals(other.path[index]!)) : stryMutAct_9fa48("617") ? false : stryMutAct_9fa48("616") ? true : (stryCov_9fa48("616", "617", "618"), (stryMutAct_9fa48("620") ? this.path.length !== other.path.length : stryMutAct_9fa48("619") ? true : (stryCov_9fa48("619", "620"), this.path.length === other.path.length)) && (stryMutAct_9fa48("621") ? this.path.some((entry, index) => entry.equals(other.path[index]!)) : (stryCov_9fa48("621"), this.path.every(stryMutAct_9fa48("622") ? () => undefined : (stryCov_9fa48("622"), (entry, index) => entry.equals(other.path[index]!))))));
    }
  }
  public staleScopes(current: PathEpochEvidence): readonly ScopeRef[] {
    if (stryMutAct_9fa48("623")) {
      {}
    } else {
      stryCov_9fa48("623");
      if (stryMutAct_9fa48("626") ? this.path.length === current.path.length : stryMutAct_9fa48("625") ? false : stryMutAct_9fa48("624") ? true : (stryCov_9fa48("624", "625", "626"), this.path.length !== current.path.length)) {
        if (stryMutAct_9fa48("627")) {
          {}
        } else {
          stryCov_9fa48("627");
          return Object.freeze(current.path.map(stryMutAct_9fa48("628") ? () => undefined : (stryCov_9fa48("628"), entry => entry.scope)));
        }
      }
      return Object.freeze(stryMutAct_9fa48("629") ? current.path.map(entry => entry.scope) : (stryCov_9fa48("629"), current.path.filter((entry, index) => {
        if (stryMutAct_9fa48("630")) {
          {}
        } else {
          stryCov_9fa48("630");
          const previous = this.path[index]!;
          return stryMutAct_9fa48("633") ? scopeKey(entry.scope) !== scopeKey(previous.scope) && entry.epoch !== previous.epoch : stryMutAct_9fa48("632") ? false : stryMutAct_9fa48("631") ? true : (stryCov_9fa48("631", "632", "633"), (stryMutAct_9fa48("635") ? scopeKey(entry.scope) === scopeKey(previous.scope) : stryMutAct_9fa48("634") ? false : (stryCov_9fa48("634", "635"), scopeKey(entry.scope) !== scopeKey(previous.scope))) || (stryMutAct_9fa48("637") ? entry.epoch === previous.epoch : stryMutAct_9fa48("636") ? false : (stryCov_9fa48("636", "637"), entry.epoch !== previous.epoch)));
        }
      }).map(stryMutAct_9fa48("638") ? () => undefined : (stryCov_9fa48("638"), entry => entry.scope))));
    }
  }
  public toData(): JsonObject {
    if (stryMutAct_9fa48("639")) {
      {}
    } else {
      stryCov_9fa48("639");
      return stryMutAct_9fa48("640") ? {} : (stryCov_9fa48("640"), {
        path: this.path.map(stryMutAct_9fa48("641") ? () => undefined : (stryCov_9fa48("641"), entry => entry.toData()))
      });
    }
  }
  public static fromData(value: JsonValue | undefined): PathEpochEvidence {
    if (stryMutAct_9fa48("642")) {
      {}
    } else {
      stryCov_9fa48("642");
      const object = requireObject(value, stryMutAct_9fa48("643") ? "" : (stryCov_9fa48("643"), "Path epoch evidence"));
      requireExact(object, stryMutAct_9fa48("644") ? [] : (stryCov_9fa48("644"), [stryMutAct_9fa48("645") ? "" : (stryCov_9fa48("645"), "path")]), stryMutAct_9fa48("646") ? "" : (stryCov_9fa48("646"), "Path epoch evidence"));
      const path = requireArray(object[stryMutAct_9fa48("647") ? "" : (stryCov_9fa48("647"), "path")], stryMutAct_9fa48("648") ? "" : (stryCov_9fa48("648"), "Path epoch evidence")).map(ScopeEpoch.fromData);
      if (stryMutAct_9fa48("651") ? path.length !== 0 : stryMutAct_9fa48("650") ? false : stryMutAct_9fa48("649") ? true : (stryCov_9fa48("649", "650", "651"), path.length === 0)) throw new TypeError(stryMutAct_9fa48("652") ? "" : (stryCov_9fa48("652"), "Path epoch evidence must not be empty"));
      return new PathEpochEvidence(path as [ScopeEpoch, ...ScopeEpoch[]]);
    }
  }
}
export class InvalidationWatermark {
  public static readonly codec: RecordCodec<InvalidationWatermark> = new InvalidationWatermarkCodecV1();
  public readonly delivered: readonly ScopeEpoch[];
  public constructor(public readonly ownerTenant: TenantId, public readonly owner: ActorRef, public readonly holder: PrincipalRef, delivered: readonly ScopeEpoch[], public readonly revision: Revision) {
    if (stryMutAct_9fa48("653")) {
      {}
    } else {
      stryCov_9fa48("653");
      const unique = new Map<string, ScopeEpoch>();
      for (const entry of delivered) {
        if (stryMutAct_9fa48("654")) {
          {}
        } else {
          stryCov_9fa48("654");
          if (stryMutAct_9fa48("657") ? false : stryMutAct_9fa48("656") ? true : stryMutAct_9fa48("655") ? entry.scope.tenantId.equals(ownerTenant) : (stryCov_9fa48("655", "656", "657"), !entry.scope.tenantId.equals(ownerTenant))) {
            if (stryMutAct_9fa48("658")) {
              {}
            } else {
              stryCov_9fa48("658");
              throw new TypeError(stryMutAct_9fa48("659") ? "" : (stryCov_9fa48("659"), "Watermark entries must belong to the owning Tenant"));
            }
          }
          const key = scopeKey(entry.scope);
          if (stryMutAct_9fa48("661") ? false : stryMutAct_9fa48("660") ? true : (stryCov_9fa48("660", "661"), unique.has(key))) throw new TypeError(stryMutAct_9fa48("662") ? "" : (stryCov_9fa48("662"), "Watermark Scope entries must be unique"));
          unique.set(key, entry);
        }
      }
      this.delivered = Object.freeze(stryMutAct_9fa48("663") ? [...unique.values()] : (stryCov_9fa48("663"), (stryMutAct_9fa48("664") ? [] : (stryCov_9fa48("664"), [...unique.values()])).sort(stryMutAct_9fa48("665") ? () => undefined : (stryCov_9fa48("665"), (left, right) => scopeKey(left.scope).localeCompare(scopeKey(right.scope))))));
      Object.freeze(this);
    }
  }
  public static empty(ownerTenant: TenantId, owner: ActorRef, holder: PrincipalRef): InvalidationWatermark {
    if (stryMutAct_9fa48("666")) {
      {}
    } else {
      stryCov_9fa48("666");
      return new InvalidationWatermark(ownerTenant, owner, holder, stryMutAct_9fa48("667") ? ["Stryker was here"] : (stryCov_9fa48("667"), []), Revision.initial());
    }
  }
  public static encode(record: InvalidationWatermark): Uint8Array {
    if (stryMutAct_9fa48("668")) {
      {}
    } else {
      stryCov_9fa48("668");
      return InvalidationWatermark.codec.encode(record);
    }
  }
  public static decode(bytes: Uint8Array): InvalidationWatermark {
    if (stryMutAct_9fa48("669")) {
      {}
    } else {
      stryCov_9fa48("669");
      return InvalidationWatermark.codec.decode(bytes);
    }
  }
  public epoch(scope: ScopeRef): number {
    if (stryMutAct_9fa48("670")) {
      {}
    } else {
      stryCov_9fa48("670");
      return stryMutAct_9fa48("671") ? this.delivered.find(entry => scopeKey(entry.scope) === scopeKey(scope))?.epoch && 0 : (stryCov_9fa48("671"), (stryMutAct_9fa48("672") ? this.delivered.find(entry => scopeKey(entry.scope) === scopeKey(scope)).epoch : (stryCov_9fa48("672"), this.delivered.find(stryMutAct_9fa48("673") ? () => undefined : (stryCov_9fa48("673"), entry => stryMutAct_9fa48("676") ? scopeKey(entry.scope) !== scopeKey(scope) : stryMutAct_9fa48("675") ? false : stryMutAct_9fa48("674") ? true : (stryCov_9fa48("674", "675", "676"), scopeKey(entry.scope) === scopeKey(scope))))?.epoch)) ?? 0);
    }
  }
  public join(entries: readonly ScopeEpoch[]): InvalidationWatermark {
    if (stryMutAct_9fa48("677")) {
      {}
    } else {
      stryCov_9fa48("677");
      const joined = new Map(this.delivered.map(stryMutAct_9fa48("678") ? () => undefined : (stryCov_9fa48("678"), entry => stryMutAct_9fa48("679") ? [] : (stryCov_9fa48("679"), [scopeKey(entry.scope), entry]))));
      let changed = stryMutAct_9fa48("680") ? true : (stryCov_9fa48("680"), false);
      for (const entry of entries) {
        if (stryMutAct_9fa48("681")) {
          {}
        } else {
          stryCov_9fa48("681");
          if (stryMutAct_9fa48("684") ? false : stryMutAct_9fa48("683") ? true : stryMutAct_9fa48("682") ? entry.scope.tenantId.equals(this.ownerTenant) : (stryCov_9fa48("682", "683", "684"), !entry.scope.tenantId.equals(this.ownerTenant))) {
            if (stryMutAct_9fa48("685")) {
              {}
            } else {
              stryCov_9fa48("685");
              throw new AgentCoreError(stryMutAct_9fa48("686") ? "" : (stryCov_9fa48("686"), "protocol.invalid-state"), stryMutAct_9fa48("687") ? "" : (stryCov_9fa48("687"), "Watermark join entries must belong to the owning Tenant"));
            }
          }
          const key = scopeKey(entry.scope);
          const previous = joined.get(key);
          if (stryMutAct_9fa48("690") ? previous === undefined && entry.epoch > previous.epoch : stryMutAct_9fa48("689") ? false : stryMutAct_9fa48("688") ? true : (stryCov_9fa48("688", "689", "690"), (stryMutAct_9fa48("692") ? previous !== undefined : stryMutAct_9fa48("691") ? false : (stryCov_9fa48("691", "692"), previous === undefined)) || (stryMutAct_9fa48("695") ? entry.epoch <= previous.epoch : stryMutAct_9fa48("694") ? entry.epoch >= previous.epoch : stryMutAct_9fa48("693") ? false : (stryCov_9fa48("693", "694", "695"), entry.epoch > previous.epoch)))) {
            if (stryMutAct_9fa48("696")) {
              {}
            } else {
              stryCov_9fa48("696");
              joined.set(key, entry);
              changed = stryMutAct_9fa48("697") ? false : (stryCov_9fa48("697"), true);
            }
          }
        }
      }
      if (stryMutAct_9fa48("700") ? changed || this.revision.value === Number.MAX_SAFE_INTEGER : stryMutAct_9fa48("699") ? false : stryMutAct_9fa48("698") ? true : (stryCov_9fa48("698", "699", "700"), changed && (stryMutAct_9fa48("702") ? this.revision.value !== Number.MAX_SAFE_INTEGER : stryMutAct_9fa48("701") ? true : (stryCov_9fa48("701", "702"), this.revision.value === Number.MAX_SAFE_INTEGER)))) {
        if (stryMutAct_9fa48("703")) {
          {}
        } else {
          stryCov_9fa48("703");
          throw new AgentCoreError(stryMutAct_9fa48("704") ? "" : (stryCov_9fa48("704"), "protocol.invalid-state"), stryMutAct_9fa48("705") ? "" : (stryCov_9fa48("705"), "Invalidation watermark revision is exhausted"));
        }
      }
      return changed ? new InvalidationWatermark(this.ownerTenant, this.owner, this.holder, stryMutAct_9fa48("706") ? [] : (stryCov_9fa48("706"), [...joined.values()]), this.revision.next()) : this;
    }
  }
  public dominates(other: InvalidationWatermark): boolean {
    if (stryMutAct_9fa48("707")) {
      {}
    } else {
      stryCov_9fa48("707");
      return stryMutAct_9fa48("710") ? this.ownerTenant.equals(other.ownerTenant) && this.owner.equals(other.owner) && this.holder.equals(other.holder) || other.delivered.every(entry => this.epoch(entry.scope) >= entry.epoch) : stryMutAct_9fa48("709") ? false : stryMutAct_9fa48("708") ? true : (stryCov_9fa48("708", "709", "710"), (stryMutAct_9fa48("712") ? this.ownerTenant.equals(other.ownerTenant) && this.owner.equals(other.owner) || this.holder.equals(other.holder) : stryMutAct_9fa48("711") ? true : (stryCov_9fa48("711", "712"), (stryMutAct_9fa48("714") ? this.ownerTenant.equals(other.ownerTenant) || this.owner.equals(other.owner) : stryMutAct_9fa48("713") ? true : (stryCov_9fa48("713", "714"), this.ownerTenant.equals(other.ownerTenant) && this.owner.equals(other.owner))) && this.holder.equals(other.holder))) && (stryMutAct_9fa48("715") ? other.delivered.some(entry => this.epoch(entry.scope) >= entry.epoch) : (stryCov_9fa48("715"), other.delivered.every(stryMutAct_9fa48("716") ? () => undefined : (stryCov_9fa48("716"), entry => stryMutAct_9fa48("720") ? this.epoch(entry.scope) < entry.epoch : stryMutAct_9fa48("719") ? this.epoch(entry.scope) > entry.epoch : stryMutAct_9fa48("718") ? false : stryMutAct_9fa48("717") ? true : (stryCov_9fa48("717", "718", "719", "720"), this.epoch(entry.scope) >= entry.epoch))))));
    }
  }
  public toData(): JsonObject {
    if (stryMutAct_9fa48("721")) {
      {}
    } else {
      stryCov_9fa48("721");
      return stryMutAct_9fa48("722") ? {} : (stryCov_9fa48("722"), {
        delivered: this.delivered.map(stryMutAct_9fa48("723") ? () => undefined : (stryCov_9fa48("723"), entry => entry.toData())),
        holder: stryMutAct_9fa48("724") ? {} : (stryCov_9fa48("724"), {
          principal: this.holder.principalId.value,
          tenant: this.holder.tenantId.value
        }),
        owner: stryMutAct_9fa48("725") ? {} : (stryCov_9fa48("725"), {
          id: this.owner.id.value,
          kind: this.owner.kind
        }),
        ownerTenant: this.ownerTenant.value,
        revision: this.revision.value
      });
    }
  }
  public static fromData(value: JsonValue | undefined): InvalidationWatermark {
    if (stryMutAct_9fa48("726")) {
      {}
    } else {
      stryCov_9fa48("726");
      const object = requireObject(value, stryMutAct_9fa48("727") ? "" : (stryCov_9fa48("727"), "Invalidation watermark"));
      requireExact(object, stryMutAct_9fa48("728") ? [] : (stryCov_9fa48("728"), [stryMutAct_9fa48("729") ? "" : (stryCov_9fa48("729"), "delivered"), stryMutAct_9fa48("730") ? "" : (stryCov_9fa48("730"), "holder"), stryMutAct_9fa48("731") ? "" : (stryCov_9fa48("731"), "owner"), stryMutAct_9fa48("732") ? "" : (stryCov_9fa48("732"), "ownerTenant"), stryMutAct_9fa48("733") ? "" : (stryCov_9fa48("733"), "revision")]), stryMutAct_9fa48("734") ? "" : (stryCov_9fa48("734"), "Invalidation watermark"));
      const holder = requireObject(object[stryMutAct_9fa48("735") ? "" : (stryCov_9fa48("735"), "holder")], stryMutAct_9fa48("736") ? "" : (stryCov_9fa48("736"), "Watermark holder"));
      const owner = requireObject(object[stryMutAct_9fa48("737") ? "" : (stryCov_9fa48("737"), "owner")], stryMutAct_9fa48("738") ? "" : (stryCov_9fa48("738"), "Watermark owner"));
      requireExact(holder, stryMutAct_9fa48("739") ? [] : (stryCov_9fa48("739"), [stryMutAct_9fa48("740") ? "" : (stryCov_9fa48("740"), "principal"), stryMutAct_9fa48("741") ? "" : (stryCov_9fa48("741"), "tenant")]), stryMutAct_9fa48("742") ? "" : (stryCov_9fa48("742"), "Watermark holder"));
      requireExact(owner, stryMutAct_9fa48("743") ? [] : (stryCov_9fa48("743"), [stryMutAct_9fa48("744") ? "" : (stryCov_9fa48("744"), "id"), stryMutAct_9fa48("745") ? "" : (stryCov_9fa48("745"), "kind")]), stryMutAct_9fa48("746") ? "" : (stryCov_9fa48("746"), "Watermark owner"));
      return new InvalidationWatermark(new TenantId(requireString(object, stryMutAct_9fa48("747") ? "" : (stryCov_9fa48("747"), "ownerTenant"), stryMutAct_9fa48("748") ? "" : (stryCov_9fa48("748"), "Watermark owner Tenant"))), new ActorRef(requireActorKind(owner[stryMutAct_9fa48("749") ? "" : (stryCov_9fa48("749"), "kind")]), new ActorId(requireString(owner, stryMutAct_9fa48("750") ? "" : (stryCov_9fa48("750"), "id"), stryMutAct_9fa48("751") ? "" : (stryCov_9fa48("751"), "Watermark owner ID")))), new PrincipalRef(new TenantId(requireString(holder, stryMutAct_9fa48("752") ? "" : (stryCov_9fa48("752"), "tenant"), stryMutAct_9fa48("753") ? "" : (stryCov_9fa48("753"), "Watermark holder Tenant"))), new PrincipalId(requireString(holder, stryMutAct_9fa48("754") ? "" : (stryCov_9fa48("754"), "principal"), stryMutAct_9fa48("755") ? "" : (stryCov_9fa48("755"), "Watermark holder Principal")))), requireArray(object[stryMutAct_9fa48("756") ? "" : (stryCov_9fa48("756"), "delivered")], stryMutAct_9fa48("757") ? "" : (stryCov_9fa48("757"), "Watermark entries")).map(ScopeEpoch.fromData), new Revision(requireSafeInteger(object, stryMutAct_9fa48("758") ? "" : (stryCov_9fa48("758"), "revision"), stryMutAct_9fa48("759") ? "" : (stryCov_9fa48("759"), "Watermark revision"))));
    }
  }
}
function validatePath(path: readonly ScopeEpoch[]): void {
  if (stryMutAct_9fa48("760")) {
    {}
  } else {
    stryCov_9fa48("760");
    if (stryMutAct_9fa48("763") ? path.length < 1 && path.length > 3 : stryMutAct_9fa48("762") ? false : stryMutAct_9fa48("761") ? true : (stryCov_9fa48("761", "762", "763"), (stryMutAct_9fa48("766") ? path.length >= 1 : stryMutAct_9fa48("765") ? path.length <= 1 : stryMutAct_9fa48("764") ? false : (stryCov_9fa48("764", "765", "766"), path.length < 1)) || (stryMutAct_9fa48("769") ? path.length <= 3 : stryMutAct_9fa48("768") ? path.length >= 3 : stryMutAct_9fa48("767") ? false : (stryCov_9fa48("767", "768", "769"), path.length > 3)))) {
      if (stryMutAct_9fa48("770")) {
        {}
      } else {
        stryCov_9fa48("770");
        throw new TypeError(stryMutAct_9fa48("771") ? "" : (stryCov_9fa48("771"), "Authority path must contain one to three Scopes"));
      }
    }
    const kinds = path.map(stryMutAct_9fa48("772") ? () => undefined : (stryCov_9fa48("772"), entry => entry.scope.kind)).join(stryMutAct_9fa48("773") ? "" : (stryCov_9fa48("773"), ","));
    if (stryMutAct_9fa48("776") ? kinds !== "tenant" && kinds !== "tenant,project" && kinds !== "tenant,workspace" || kinds !== "tenant,project,workspace" : stryMutAct_9fa48("775") ? false : stryMutAct_9fa48("774") ? true : (stryCov_9fa48("774", "775", "776"), (stryMutAct_9fa48("778") ? kinds !== "tenant" && kinds !== "tenant,project" || kinds !== "tenant,workspace" : stryMutAct_9fa48("777") ? true : (stryCov_9fa48("777", "778"), (stryMutAct_9fa48("780") ? kinds !== "tenant" || kinds !== "tenant,project" : stryMutAct_9fa48("779") ? true : (stryCov_9fa48("779", "780"), (stryMutAct_9fa48("782") ? kinds === "tenant" : stryMutAct_9fa48("781") ? true : (stryCov_9fa48("781", "782"), kinds !== (stryMutAct_9fa48("783") ? "" : (stryCov_9fa48("783"), "tenant")))) && (stryMutAct_9fa48("785") ? kinds === "tenant,project" : stryMutAct_9fa48("784") ? true : (stryCov_9fa48("784", "785"), kinds !== (stryMutAct_9fa48("786") ? "" : (stryCov_9fa48("786"), "tenant,project")))))) && (stryMutAct_9fa48("788") ? kinds === "tenant,workspace" : stryMutAct_9fa48("787") ? true : (stryCov_9fa48("787", "788"), kinds !== (stryMutAct_9fa48("789") ? "" : (stryCov_9fa48("789"), "tenant,workspace")))))) && (stryMutAct_9fa48("791") ? kinds === "tenant,project,workspace" : stryMutAct_9fa48("790") ? true : (stryCov_9fa48("790", "791"), kinds !== (stryMutAct_9fa48("792") ? "" : (stryCov_9fa48("792"), "tenant,project,workspace")))))) {
      if (stryMutAct_9fa48("793")) {
        {}
      } else {
        stryCov_9fa48("793");
        throw new TypeError(stryMutAct_9fa48("794") ? "" : (stryCov_9fa48("794"), "Authority path must be an exact Tenant-to-target Scope chain"));
      }
    }
    if (stryMutAct_9fa48("797") ? new Set(path.map(entry => scopeKey(entry.scope))).size === path.length : stryMutAct_9fa48("796") ? false : stryMutAct_9fa48("795") ? true : (stryCov_9fa48("795", "796", "797"), new Set(path.map(stryMutAct_9fa48("798") ? () => undefined : (stryCov_9fa48("798"), entry => scopeKey(entry.scope)))).size !== path.length)) {
      if (stryMutAct_9fa48("799")) {
        {}
      } else {
        stryCov_9fa48("799");
        throw new TypeError(stryMutAct_9fa48("800") ? "" : (stryCov_9fa48("800"), "Authority path Scopes must be unique"));
      }
    }
    const target = path[stryMutAct_9fa48("801") ? path.length + 1 : (stryCov_9fa48("801"), path.length - 1)]!.scope;
    if (stryMutAct_9fa48("804") ? path.every(entry => !entry.scope.tenantId.equals(target.tenantId)) : stryMutAct_9fa48("803") ? false : stryMutAct_9fa48("802") ? true : (stryCov_9fa48("802", "803", "804"), path.some(stryMutAct_9fa48("805") ? () => undefined : (stryCov_9fa48("805"), entry => stryMutAct_9fa48("806") ? entry.scope.tenantId.equals(target.tenantId) : (stryCov_9fa48("806"), !entry.scope.tenantId.equals(target.tenantId)))))) {
      if (stryMutAct_9fa48("807")) {
        {}
      } else {
        stryCov_9fa48("807");
        throw new TypeError(stryMutAct_9fa48("808") ? "" : (stryCov_9fa48("808"), "Authority path Scopes must share one Tenant"));
      }
    }
    if (stryMutAct_9fa48("811") ? target.kind === "workspace" || target.projectId !== undefined : stryMutAct_9fa48("810") ? false : stryMutAct_9fa48("809") ? true : (stryCov_9fa48("809", "810", "811"), (stryMutAct_9fa48("813") ? target.kind !== "workspace" : stryMutAct_9fa48("812") ? true : (stryCov_9fa48("812", "813"), target.kind === (stryMutAct_9fa48("814") ? "" : (stryCov_9fa48("814"), "workspace")))) && (stryMutAct_9fa48("816") ? target.projectId === undefined : stryMutAct_9fa48("815") ? true : (stryCov_9fa48("815", "816"), target.projectId !== undefined)))) {
      if (stryMutAct_9fa48("817")) {
        {}
      } else {
        stryCov_9fa48("817");
        const project = stryMutAct_9fa48("818") ? path.find(entry => entry.scope.kind === "project").scope : (stryCov_9fa48("818"), path.find(stryMutAct_9fa48("819") ? () => undefined : (stryCov_9fa48("819"), entry => stryMutAct_9fa48("822") ? entry.scope.kind !== "project" : stryMutAct_9fa48("821") ? false : stryMutAct_9fa48("820") ? true : (stryCov_9fa48("820", "821", "822"), entry.scope.kind === (stryMutAct_9fa48("823") ? "" : (stryCov_9fa48("823"), "project")))))?.scope);
        if (stryMutAct_9fa48("826") ? project?.projectId === undefined && !project.projectId.equals(target.projectId) : stryMutAct_9fa48("825") ? false : stryMutAct_9fa48("824") ? true : (stryCov_9fa48("824", "825", "826"), (stryMutAct_9fa48("828") ? project?.projectId !== undefined : stryMutAct_9fa48("827") ? false : (stryCov_9fa48("827", "828"), (stryMutAct_9fa48("829") ? project.projectId : (stryCov_9fa48("829"), project?.projectId)) === undefined)) || (stryMutAct_9fa48("830") ? project.projectId.equals(target.projectId) : (stryCov_9fa48("830"), !project.projectId.equals(target.projectId))))) {
          if (stryMutAct_9fa48("831")) {
            {}
          } else {
            stryCov_9fa48("831");
            throw new TypeError(stryMutAct_9fa48("832") ? "" : (stryCov_9fa48("832"), "Authority path must include the Workspace's exact Project"));
          }
        }
      }
    }
    const exact = target.path;
    if (stryMutAct_9fa48("835") ? exact.length !== path.length && exact.some((scope, index) => !scope.equals(path[index]!.scope)) : stryMutAct_9fa48("834") ? false : stryMutAct_9fa48("833") ? true : (stryCov_9fa48("833", "834", "835"), (stryMutAct_9fa48("837") ? exact.length === path.length : stryMutAct_9fa48("836") ? false : (stryCov_9fa48("836", "837"), exact.length !== path.length)) || (stryMutAct_9fa48("838") ? exact.every((scope, index) => !scope.equals(path[index]!.scope)) : (stryCov_9fa48("838"), exact.some(stryMutAct_9fa48("839") ? () => undefined : (stryCov_9fa48("839"), (scope, index) => stryMutAct_9fa48("840") ? scope.equals(path[index]!.scope) : (stryCov_9fa48("840"), !scope.equals(path[index]!.scope)))))))) {
      if (stryMutAct_9fa48("841")) {
        {}
      } else {
        stryCov_9fa48("841");
        throw new TypeError(stryMutAct_9fa48("842") ? "" : (stryCov_9fa48("842"), "Authority path must equal the target Scope's canonical ancestry"));
      }
    }
  }
}
function requireActorKind(value: JsonValue | undefined): ActorKind {
  if (stryMutAct_9fa48("843")) {
    {}
  } else {
    stryCov_9fa48("843");
    if (stryMutAct_9fa48("846") ? (value === "tenant" || value === "workspace" || value === "run" || value === "environment") && value === "slate" : stryMutAct_9fa48("845") ? false : stryMutAct_9fa48("844") ? true : (stryCov_9fa48("844", "845", "846"), (stryMutAct_9fa48("848") ? (value === "tenant" || value === "workspace" || value === "run") && value === "environment" : stryMutAct_9fa48("847") ? false : (stryCov_9fa48("847", "848"), (stryMutAct_9fa48("850") ? (value === "tenant" || value === "workspace") && value === "run" : stryMutAct_9fa48("849") ? false : (stryCov_9fa48("849", "850"), (stryMutAct_9fa48("852") ? value === "tenant" && value === "workspace" : stryMutAct_9fa48("851") ? false : (stryCov_9fa48("851", "852"), (stryMutAct_9fa48("854") ? value !== "tenant" : stryMutAct_9fa48("853") ? false : (stryCov_9fa48("853", "854"), value === (stryMutAct_9fa48("855") ? "" : (stryCov_9fa48("855"), "tenant")))) || (stryMutAct_9fa48("857") ? value !== "workspace" : stryMutAct_9fa48("856") ? false : (stryCov_9fa48("856", "857"), value === (stryMutAct_9fa48("858") ? "" : (stryCov_9fa48("858"), "workspace")))))) || (stryMutAct_9fa48("860") ? value !== "run" : stryMutAct_9fa48("859") ? false : (stryCov_9fa48("859", "860"), value === (stryMutAct_9fa48("861") ? "" : (stryCov_9fa48("861"), "run")))))) || (stryMutAct_9fa48("863") ? value !== "environment" : stryMutAct_9fa48("862") ? false : (stryCov_9fa48("862", "863"), value === (stryMutAct_9fa48("864") ? "" : (stryCov_9fa48("864"), "environment")))))) || (stryMutAct_9fa48("866") ? value !== "slate" : stryMutAct_9fa48("865") ? false : (stryCov_9fa48("865", "866"), value === (stryMutAct_9fa48("867") ? "" : (stryCov_9fa48("867"), "slate")))))) return value;
    throw new TypeError(stryMutAct_9fa48("868") ? "" : (stryCov_9fa48("868"), "Watermark owner Actor kind is invalid"));
  }
}