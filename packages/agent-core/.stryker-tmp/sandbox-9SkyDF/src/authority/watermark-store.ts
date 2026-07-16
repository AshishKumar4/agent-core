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
import { AgentCoreError } from "../errors";
import type { ActorRef } from "../actors";
import type { TenantId } from "../identity";
import { authorityKey } from "./key";
import { InvalidationWatermark, type ScopeEpoch } from "./epoch";
export interface InvalidationWatermarkStore {
  load(key: string): InvalidationWatermark | undefined;
  save(watermark: InvalidationWatermark): void;
  join(key: string, entries: readonly ScopeEpoch[]): InvalidationWatermark;
}
export interface MemoryInvalidationWatermarkSnapshot {
  readonly version: 1;
  readonly records: readonly {
    readonly key: string;
    readonly bytes: Uint8Array;
  }[];
}
export class MemoryInvalidationWatermarkStore implements InvalidationWatermarkStore {
  readonly #records = new Map<string, Uint8Array>();
  public constructor(private readonly ownerTenant: TenantId, private readonly owner: ActorRef, snapshot: MemoryInvalidationWatermarkSnapshot = stryMutAct_9fa48("4157") ? {} : (stryCov_9fa48("4157"), {
    version: 1,
    records: stryMutAct_9fa48("4158") ? ["Stryker was here"] : (stryCov_9fa48("4158"), [])
  })) {
    if (stryMutAct_9fa48("4159")) {
      {}
    } else {
      stryCov_9fa48("4159");
      requireSnapshot(snapshot);
      for (const stored of snapshot.records) {
        if (stryMutAct_9fa48("4160")) {
          {}
        } else {
          stryCov_9fa48("4160");
          if (stryMutAct_9fa48("4162") ? false : stryMutAct_9fa48("4161") ? true : (stryCov_9fa48("4161", "4162"), this.#records.has(stored.key))) {
            if (stryMutAct_9fa48("4163")) {
              {}
            } else {
              stryCov_9fa48("4163");
              throw corruptWatermarkSnapshot(stryMutAct_9fa48("4164") ? "" : (stryCov_9fa48("4164"), "Memory watermark snapshot contains duplicate keys"));
            }
          }
          const watermark = InvalidationWatermark.decode(stryMutAct_9fa48("4165") ? stored.bytes : (stryCov_9fa48("4165"), stored.bytes.slice()));
          if (stryMutAct_9fa48("4168") ? (watermarkKey(watermark) !== stored.key || !watermark.ownerTenant.equals(ownerTenant)) && !watermark.owner.equals(owner) : stryMutAct_9fa48("4167") ? false : stryMutAct_9fa48("4166") ? true : (stryCov_9fa48("4166", "4167", "4168"), (stryMutAct_9fa48("4170") ? watermarkKey(watermark) !== stored.key && !watermark.ownerTenant.equals(ownerTenant) : stryMutAct_9fa48("4169") ? false : (stryCov_9fa48("4169", "4170"), (stryMutAct_9fa48("4172") ? watermarkKey(watermark) === stored.key : stryMutAct_9fa48("4171") ? false : (stryCov_9fa48("4171", "4172"), watermarkKey(watermark) !== stored.key)) || (stryMutAct_9fa48("4173") ? watermark.ownerTenant.equals(ownerTenant) : (stryCov_9fa48("4173"), !watermark.ownerTenant.equals(ownerTenant))))) || (stryMutAct_9fa48("4174") ? watermark.owner.equals(owner) : (stryCov_9fa48("4174"), !watermark.owner.equals(owner))))) {
            if (stryMutAct_9fa48("4175")) {
              {}
            } else {
              stryCov_9fa48("4175");
              throw corruptWatermarkSnapshot(stryMutAct_9fa48("4176") ? "" : (stryCov_9fa48("4176"), "Memory watermark key does not match codec bytes"));
            }
          }
          this.#records.set(stored.key, stryMutAct_9fa48("4177") ? stored.bytes : (stryCov_9fa48("4177"), stored.bytes.slice()));
        }
      }
    }
  }
  public load(key: string): InvalidationWatermark | undefined {
    if (stryMutAct_9fa48("4178")) {
      {}
    } else {
      stryCov_9fa48("4178");
      const bytes = this.#records.get(key);
      return (stryMutAct_9fa48("4181") ? bytes !== undefined : stryMutAct_9fa48("4180") ? false : stryMutAct_9fa48("4179") ? true : (stryCov_9fa48("4179", "4180", "4181"), bytes === undefined)) ? undefined : InvalidationWatermark.decode(stryMutAct_9fa48("4182") ? bytes : (stryCov_9fa48("4182"), bytes.slice()));
    }
  }
  public save(watermark: InvalidationWatermark): void {
    if (stryMutAct_9fa48("4183")) {
      {}
    } else {
      stryCov_9fa48("4183");
      if (stryMutAct_9fa48("4186") ? !watermark.ownerTenant.equals(this.ownerTenant) && !watermark.owner.equals(this.owner) : stryMutAct_9fa48("4185") ? false : stryMutAct_9fa48("4184") ? true : (stryCov_9fa48("4184", "4185", "4186"), (stryMutAct_9fa48("4187") ? watermark.ownerTenant.equals(this.ownerTenant) : (stryCov_9fa48("4187"), !watermark.ownerTenant.equals(this.ownerTenant))) || (stryMutAct_9fa48("4188") ? watermark.owner.equals(this.owner) : (stryCov_9fa48("4188"), !watermark.owner.equals(this.owner))))) {
        if (stryMutAct_9fa48("4189")) {
          {}
        } else {
          stryCov_9fa48("4189");
          throw new AgentCoreError(stryMutAct_9fa48("4190") ? "" : (stryCov_9fa48("4190"), "protocol.invalid-state"), stryMutAct_9fa48("4191") ? "" : (stryCov_9fa48("4191"), "Watermark belongs to another Actor store"));
        }
      }
      const key = watermarkKey(watermark);
      const previous = this.load(key);
      if (stryMutAct_9fa48("4194") ? previous !== undefined : stryMutAct_9fa48("4193") ? false : stryMutAct_9fa48("4192") ? true : (stryCov_9fa48("4192", "4193", "4194"), previous === undefined)) {
        if (stryMutAct_9fa48("4195")) {
          {}
        } else {
          stryCov_9fa48("4195");
          if (stryMutAct_9fa48("4198") ? watermark.revision.value === 0 : stryMutAct_9fa48("4197") ? false : stryMutAct_9fa48("4196") ? true : (stryCov_9fa48("4196", "4197", "4198"), watermark.revision.value !== 0)) {
            if (stryMutAct_9fa48("4199")) {
              {}
            } else {
              stryCov_9fa48("4199");
              throw new AgentCoreError(stryMutAct_9fa48("4200") ? "" : (stryCov_9fa48("4200"), "protocol.revision-conflict"), stryMutAct_9fa48("4201") ? "" : (stryCov_9fa48("4201"), "New watermarks require revision zero"));
            }
          }
        }
      } else {
        if (stryMutAct_9fa48("4202")) {
          {}
        } else {
          stryCov_9fa48("4202");
          const previousBytes = InvalidationWatermark.encode(previous);
          const nextBytes = InvalidationWatermark.encode(watermark);
          if (stryMutAct_9fa48("4204") ? false : stryMutAct_9fa48("4203") ? true : (stryCov_9fa48("4203", "4204"), bytesEqual(previousBytes, nextBytes))) return;
          if (stryMutAct_9fa48("4207") ? watermark.revision.value !== previous.revision.value + 1 && !watermark.dominates(previous) : stryMutAct_9fa48("4206") ? false : stryMutAct_9fa48("4205") ? true : (stryCov_9fa48("4205", "4206", "4207"), (stryMutAct_9fa48("4209") ? watermark.revision.value === previous.revision.value + 1 : stryMutAct_9fa48("4208") ? false : (stryCov_9fa48("4208", "4209"), watermark.revision.value !== (stryMutAct_9fa48("4210") ? previous.revision.value - 1 : (stryCov_9fa48("4210"), previous.revision.value + 1)))) || (stryMutAct_9fa48("4211") ? watermark.dominates(previous) : (stryCov_9fa48("4211"), !watermark.dominates(previous))))) {
            if (stryMutAct_9fa48("4212")) {
              {}
            } else {
              stryCov_9fa48("4212");
              throw new AgentCoreError(stryMutAct_9fa48("4213") ? "" : (stryCov_9fa48("4213"), "protocol.revision-conflict"), stryMutAct_9fa48("4214") ? "" : (stryCov_9fa48("4214"), "Watermark updates require monotonic entries and the next revision"));
            }
          }
        }
      }
      this.#records.set(key, InvalidationWatermark.encode(watermark));
    }
  }
  public join(key: string, entries: readonly ScopeEpoch[]): InvalidationWatermark {
    if (stryMutAct_9fa48("4215")) {
      {}
    } else {
      stryCov_9fa48("4215");
      const current = this.load(key);
      if (stryMutAct_9fa48("4218") ? current !== undefined : stryMutAct_9fa48("4217") ? false : stryMutAct_9fa48("4216") ? true : (stryCov_9fa48("4216", "4217", "4218"), current === undefined)) {
        if (stryMutAct_9fa48("4219")) {
          {}
        } else {
          stryCov_9fa48("4219");
          throw new AgentCoreError(stryMutAct_9fa48("4220") ? "" : (stryCov_9fa48("4220"), "protocol.invalid-state"), stryMutAct_9fa48("4221") ? "" : (stryCov_9fa48("4221"), "Watermark must be initialized before join"));
        }
      }
      const joined = current.join(entries);
      this.save(joined);
      return joined;
    }
  }
  public snapshot(): MemoryInvalidationWatermarkSnapshot {
    if (stryMutAct_9fa48("4222")) {
      {}
    } else {
      stryCov_9fa48("4222");
      return Object.freeze(stryMutAct_9fa48("4223") ? {} : (stryCov_9fa48("4223"), {
        version: 1,
        records: Object.freeze(stryMutAct_9fa48("4224") ? [...this.#records.entries()].map(([key, bytes]) => Object.freeze({
          key,
          bytes: bytes.slice()
        })) : (stryCov_9fa48("4224"), (stryMutAct_9fa48("4225") ? [] : (stryCov_9fa48("4225"), [...this.#records.entries()])).sort(stryMutAct_9fa48("4226") ? () => undefined : (stryCov_9fa48("4226"), ([left], [right]) => left.localeCompare(right))).map(stryMutAct_9fa48("4227") ? () => undefined : (stryCov_9fa48("4227"), ([key, bytes]) => Object.freeze(stryMutAct_9fa48("4228") ? {} : (stryCov_9fa48("4228"), {
          key,
          bytes: stryMutAct_9fa48("4229") ? bytes : (stryCov_9fa48("4229"), bytes.slice())
        }))))))
      }));
    }
  }
}
export function watermarkKey(watermark: InvalidationWatermark): string {
  if (stryMutAct_9fa48("4230")) {
    {}
  } else {
    stryCov_9fa48("4230");
    return authorityKey(stryMutAct_9fa48("4231") ? "" : (stryCov_9fa48("4231"), "principal"), stryMutAct_9fa48("4232") ? [] : (stryCov_9fa48("4232"), [watermark.ownerTenant.value, watermark.owner.kind, watermark.owner.id.value, watermark.holder.tenantId.value, watermark.holder.principalId.value]));
  }
}
function requireSnapshot(snapshot: MemoryInvalidationWatermarkSnapshot): void {
  if (stryMutAct_9fa48("4233")) {
    {}
  } else {
    stryCov_9fa48("4233");
    if (stryMutAct_9fa48("4236") ? (snapshot === null || typeof snapshot !== "object" || JSON.stringify(Object.keys(snapshot).sort()) !== JSON.stringify(["records", "version"]) || snapshot.version !== 1) && !Array.isArray(snapshot.records) : stryMutAct_9fa48("4235") ? false : stryMutAct_9fa48("4234") ? true : (stryCov_9fa48("4234", "4235", "4236"), (stryMutAct_9fa48("4238") ? (snapshot === null || typeof snapshot !== "object" || JSON.stringify(Object.keys(snapshot).sort()) !== JSON.stringify(["records", "version"])) && snapshot.version !== 1 : stryMutAct_9fa48("4237") ? false : (stryCov_9fa48("4237", "4238"), (stryMutAct_9fa48("4240") ? (snapshot === null || typeof snapshot !== "object") && JSON.stringify(Object.keys(snapshot).sort()) !== JSON.stringify(["records", "version"]) : stryMutAct_9fa48("4239") ? false : (stryCov_9fa48("4239", "4240"), (stryMutAct_9fa48("4242") ? snapshot === null && typeof snapshot !== "object" : stryMutAct_9fa48("4241") ? false : (stryCov_9fa48("4241", "4242"), (stryMutAct_9fa48("4244") ? snapshot !== null : stryMutAct_9fa48("4243") ? false : (stryCov_9fa48("4243", "4244"), snapshot === null)) || (stryMutAct_9fa48("4246") ? typeof snapshot === "object" : stryMutAct_9fa48("4245") ? false : (stryCov_9fa48("4245", "4246"), typeof snapshot !== (stryMutAct_9fa48("4247") ? "" : (stryCov_9fa48("4247"), "object")))))) || (stryMutAct_9fa48("4249") ? JSON.stringify(Object.keys(snapshot).sort()) === JSON.stringify(["records", "version"]) : stryMutAct_9fa48("4248") ? false : (stryCov_9fa48("4248", "4249"), JSON.stringify(stryMutAct_9fa48("4250") ? Object.keys(snapshot) : (stryCov_9fa48("4250"), Object.keys(snapshot).sort())) !== JSON.stringify(stryMutAct_9fa48("4251") ? [] : (stryCov_9fa48("4251"), [stryMutAct_9fa48("4252") ? "" : (stryCov_9fa48("4252"), "records"), stryMutAct_9fa48("4253") ? "" : (stryCov_9fa48("4253"), "version")])))))) || (stryMutAct_9fa48("4255") ? snapshot.version === 1 : stryMutAct_9fa48("4254") ? false : (stryCov_9fa48("4254", "4255"), snapshot.version !== 1)))) || (stryMutAct_9fa48("4256") ? Array.isArray(snapshot.records) : (stryCov_9fa48("4256"), !Array.isArray(snapshot.records))))) {
      if (stryMutAct_9fa48("4257")) {
        {}
      } else {
        stryCov_9fa48("4257");
        throw corruptWatermarkSnapshot(stryMutAct_9fa48("4258") ? "" : (stryCov_9fa48("4258"), "Memory watermark snapshot is malformed"));
      }
    }
    for (const record of snapshot.records) {
      if (stryMutAct_9fa48("4259")) {
        {}
      } else {
        stryCov_9fa48("4259");
        if (stryMutAct_9fa48("4262") ? (record === null || typeof record !== "object" || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["bytes", "key"]) || typeof record.key !== "string" || record.key.length === 0) && !(record.bytes instanceof Uint8Array) : stryMutAct_9fa48("4261") ? false : stryMutAct_9fa48("4260") ? true : (stryCov_9fa48("4260", "4261", "4262"), (stryMutAct_9fa48("4264") ? (record === null || typeof record !== "object" || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["bytes", "key"]) || typeof record.key !== "string") && record.key.length === 0 : stryMutAct_9fa48("4263") ? false : (stryCov_9fa48("4263", "4264"), (stryMutAct_9fa48("4266") ? (record === null || typeof record !== "object" || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["bytes", "key"])) && typeof record.key !== "string" : stryMutAct_9fa48("4265") ? false : (stryCov_9fa48("4265", "4266"), (stryMutAct_9fa48("4268") ? (record === null || typeof record !== "object") && JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["bytes", "key"]) : stryMutAct_9fa48("4267") ? false : (stryCov_9fa48("4267", "4268"), (stryMutAct_9fa48("4270") ? record === null && typeof record !== "object" : stryMutAct_9fa48("4269") ? false : (stryCov_9fa48("4269", "4270"), (stryMutAct_9fa48("4272") ? record !== null : stryMutAct_9fa48("4271") ? false : (stryCov_9fa48("4271", "4272"), record === null)) || (stryMutAct_9fa48("4274") ? typeof record === "object" : stryMutAct_9fa48("4273") ? false : (stryCov_9fa48("4273", "4274"), typeof record !== (stryMutAct_9fa48("4275") ? "" : (stryCov_9fa48("4275"), "object")))))) || (stryMutAct_9fa48("4277") ? JSON.stringify(Object.keys(record).sort()) === JSON.stringify(["bytes", "key"]) : stryMutAct_9fa48("4276") ? false : (stryCov_9fa48("4276", "4277"), JSON.stringify(stryMutAct_9fa48("4278") ? Object.keys(record) : (stryCov_9fa48("4278"), Object.keys(record).sort())) !== JSON.stringify(stryMutAct_9fa48("4279") ? [] : (stryCov_9fa48("4279"), [stryMutAct_9fa48("4280") ? "" : (stryCov_9fa48("4280"), "bytes"), stryMutAct_9fa48("4281") ? "" : (stryCov_9fa48("4281"), "key")])))))) || (stryMutAct_9fa48("4283") ? typeof record.key === "string" : stryMutAct_9fa48("4282") ? false : (stryCov_9fa48("4282", "4283"), typeof record.key !== (stryMutAct_9fa48("4284") ? "" : (stryCov_9fa48("4284"), "string")))))) || (stryMutAct_9fa48("4286") ? record.key.length !== 0 : stryMutAct_9fa48("4285") ? false : (stryCov_9fa48("4285", "4286"), record.key.length === 0)))) || (stryMutAct_9fa48("4287") ? record.bytes instanceof Uint8Array : (stryCov_9fa48("4287"), !(record.bytes instanceof Uint8Array))))) {
          if (stryMutAct_9fa48("4288")) {
            {}
          } else {
            stryCov_9fa48("4288");
            throw corruptWatermarkSnapshot(stryMutAct_9fa48("4289") ? "" : (stryCov_9fa48("4289"), "Memory watermark snapshot record is malformed"));
          }
        }
      }
    }
  }
}
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (stryMutAct_9fa48("4290")) {
    {}
  } else {
    stryCov_9fa48("4290");
    return stryMutAct_9fa48("4293") ? left.byteLength === right.byteLength || left.every((value, index) => value === right[index]) : stryMutAct_9fa48("4292") ? false : stryMutAct_9fa48("4291") ? true : (stryCov_9fa48("4291", "4292", "4293"), (stryMutAct_9fa48("4295") ? left.byteLength !== right.byteLength : stryMutAct_9fa48("4294") ? true : (stryCov_9fa48("4294", "4295"), left.byteLength === right.byteLength)) && (stryMutAct_9fa48("4296") ? left.some((value, index) => value === right[index]) : (stryCov_9fa48("4296"), left.every(stryMutAct_9fa48("4297") ? () => undefined : (stryCov_9fa48("4297"), (value, index) => stryMutAct_9fa48("4300") ? value !== right[index] : stryMutAct_9fa48("4299") ? false : stryMutAct_9fa48("4298") ? true : (stryCov_9fa48("4298", "4299", "4300"), value === right[index]))))));
  }
}
function corruptWatermarkSnapshot(message: string): AgentCoreError {
  if (stryMutAct_9fa48("4301")) {
    {}
  } else {
    stryCov_9fa48("4301");
    return new AgentCoreError(stryMutAct_9fa48("4302") ? "" : (stryCov_9fa48("4302"), "codec.invalid"), message);
  }
}