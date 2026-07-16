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
import type { ScopeRef } from "../identity";
import { Binding } from "./binding";
export interface BindingStore {
  load(key: string): Binding | undefined;
  list(): readonly Binding[];
  save(binding: Binding): void;
}
export interface MemoryBindingSnapshot {
  readonly version: 1;
  readonly records: readonly {
    readonly key: string;
    readonly bytes: Uint8Array;
  }[];
}
export class MemoryBindingStore implements BindingStore {
  readonly #records = new Map<string, Uint8Array>();
  public constructor(private readonly workspaceScope: ScopeRef, snapshot: MemoryBindingSnapshot = stryMutAct_9fa48("174") ? {} : (stryCov_9fa48("174"), {
    version: 1,
    records: stryMutAct_9fa48("175") ? ["Stryker was here"] : (stryCov_9fa48("175"), [])
  })) {
    if (stryMutAct_9fa48("176")) {
      {}
    } else {
      stryCov_9fa48("176");
      requireWorkspaceScope(workspaceScope);
      requireSnapshot(snapshot);
      for (const stored of snapshot.records) {
        if (stryMutAct_9fa48("177")) {
          {}
        } else {
          stryCov_9fa48("177");
          if (stryMutAct_9fa48("179") ? false : stryMutAct_9fa48("178") ? true : (stryCov_9fa48("178", "179"), this.#records.has(stored.key))) {
            if (stryMutAct_9fa48("180")) {
              {}
            } else {
              stryCov_9fa48("180");
              throw corruptBindingSnapshot(stryMutAct_9fa48("181") ? "" : (stryCov_9fa48("181"), "Memory Binding snapshot contains duplicate keys"));
            }
          }
          const binding = Binding.decode(stryMutAct_9fa48("182") ? stored.bytes : (stryCov_9fa48("182"), stored.bytes.slice()));
          if (stryMutAct_9fa48("185") ? binding.key !== stored.key && !binding.scope.equals(workspaceScope) : stryMutAct_9fa48("184") ? false : stryMutAct_9fa48("183") ? true : (stryCov_9fa48("183", "184", "185"), (stryMutAct_9fa48("187") ? binding.key === stored.key : stryMutAct_9fa48("186") ? false : (stryCov_9fa48("186", "187"), binding.key !== stored.key)) || (stryMutAct_9fa48("188") ? binding.scope.equals(workspaceScope) : (stryCov_9fa48("188"), !binding.scope.equals(workspaceScope))))) {
            if (stryMutAct_9fa48("189")) {
              {}
            } else {
              stryCov_9fa48("189");
              throw corruptBindingSnapshot(stryMutAct_9fa48("190") ? "" : (stryCov_9fa48("190"), "Memory Binding key does not match codec bytes"));
            }
          }
          this.#records.set(stored.key, stryMutAct_9fa48("191") ? stored.bytes : (stryCov_9fa48("191"), stored.bytes.slice()));
        }
      }
    }
  }
  public load(key: string): Binding | undefined {
    if (stryMutAct_9fa48("192")) {
      {}
    } else {
      stryCov_9fa48("192");
      const bytes = this.#records.get(key);
      return (stryMutAct_9fa48("195") ? bytes !== undefined : stryMutAct_9fa48("194") ? false : stryMutAct_9fa48("193") ? true : (stryCov_9fa48("193", "194", "195"), bytes === undefined)) ? undefined : Binding.decode(stryMutAct_9fa48("196") ? bytes : (stryCov_9fa48("196"), bytes.slice()));
    }
  }
  public list(): readonly Binding[] {
    if (stryMutAct_9fa48("197")) {
      {}
    } else {
      stryCov_9fa48("197");
      return Object.freeze(stryMutAct_9fa48("198") ? [...this.#records.keys()].map(key => this.load(key)!) : (stryCov_9fa48("198"), (stryMutAct_9fa48("199") ? [] : (stryCov_9fa48("199"), [...this.#records.keys()])).sort().map(stryMutAct_9fa48("200") ? () => undefined : (stryCov_9fa48("200"), key => this.load(key)!))));
    }
  }
  public save(binding: Binding): void {
    if (stryMutAct_9fa48("201")) {
      {}
    } else {
      stryCov_9fa48("201");
      if (stryMutAct_9fa48("204") ? false : stryMutAct_9fa48("203") ? true : stryMutAct_9fa48("202") ? binding.scope.equals(this.workspaceScope) : (stryCov_9fa48("202", "203", "204"), !binding.scope.equals(this.workspaceScope))) {
        if (stryMutAct_9fa48("205")) {
          {}
        } else {
          stryCov_9fa48("205");
          throw new AgentCoreError(stryMutAct_9fa48("206") ? "" : (stryCov_9fa48("206"), "binding.invalid"), stryMutAct_9fa48("207") ? "" : (stryCov_9fa48("207"), "Binding belongs to another Workspace store"));
        }
      }
      const previous = this.load(binding.key);
      if (stryMutAct_9fa48("210") ? previous !== undefined : stryMutAct_9fa48("209") ? false : stryMutAct_9fa48("208") ? true : (stryCov_9fa48("208", "209", "210"), previous === undefined)) {
        if (stryMutAct_9fa48("211")) {
          {}
        } else {
          stryCov_9fa48("211");
          if (stryMutAct_9fa48("214") ? binding.generation !== 0 && binding.revision.value !== 0 : stryMutAct_9fa48("213") ? false : stryMutAct_9fa48("212") ? true : (stryCov_9fa48("212", "213", "214"), (stryMutAct_9fa48("216") ? binding.generation === 0 : stryMutAct_9fa48("215") ? false : (stryCov_9fa48("215", "216"), binding.generation !== 0)) || (stryMutAct_9fa48("218") ? binding.revision.value === 0 : stryMutAct_9fa48("217") ? false : (stryCov_9fa48("217", "218"), binding.revision.value !== 0)))) {
            if (stryMutAct_9fa48("219")) {
              {}
            } else {
              stryCov_9fa48("219");
              throw new AgentCoreError(stryMutAct_9fa48("220") ? "" : (stryCov_9fa48("220"), "protocol.revision-conflict"), stryMutAct_9fa48("221") ? "" : (stryCov_9fa48("221"), "New Bindings require generation and revision zero"));
            }
          }
        }
      } else {
        if (stryMutAct_9fa48("222")) {
          {}
        } else {
          stryCov_9fa48("222");
          const previousBytes = Binding.encode(previous);
          const nextBytes = Binding.encode(binding);
          if (stryMutAct_9fa48("224") ? false : stryMutAct_9fa48("223") ? true : (stryCov_9fa48("223", "224"), bytesEqual(previousBytes, nextBytes))) return;
          previous.assertCanReplace(binding);
        }
      }
      this.#records.set(binding.key, Binding.encode(binding));
    }
  }
  public snapshot(): MemoryBindingSnapshot {
    if (stryMutAct_9fa48("225")) {
      {}
    } else {
      stryCov_9fa48("225");
      return Object.freeze(stryMutAct_9fa48("226") ? {} : (stryCov_9fa48("226"), {
        version: 1,
        records: Object.freeze(stryMutAct_9fa48("227") ? [...this.#records.entries()].map(([key, bytes]) => Object.freeze({
          key,
          bytes: bytes.slice()
        })) : (stryCov_9fa48("227"), (stryMutAct_9fa48("228") ? [] : (stryCov_9fa48("228"), [...this.#records.entries()])).sort(stryMutAct_9fa48("229") ? () => undefined : (stryCov_9fa48("229"), ([left], [right]) => left.localeCompare(right))).map(stryMutAct_9fa48("230") ? () => undefined : (stryCov_9fa48("230"), ([key, bytes]) => Object.freeze(stryMutAct_9fa48("231") ? {} : (stryCov_9fa48("231"), {
          key,
          bytes: stryMutAct_9fa48("232") ? bytes : (stryCov_9fa48("232"), bytes.slice())
        }))))))
      }));
    }
  }
}
function requireWorkspaceScope(scope: ScopeRef): void {
  if (stryMutAct_9fa48("233")) {
    {}
  } else {
    stryCov_9fa48("233");
    if (stryMutAct_9fa48("236") ? scope.kind === "workspace" : stryMutAct_9fa48("235") ? false : stryMutAct_9fa48("234") ? true : (stryCov_9fa48("234", "235", "236"), scope.kind !== (stryMutAct_9fa48("237") ? "" : (stryCov_9fa48("237"), "workspace")))) throw new TypeError(stryMutAct_9fa48("238") ? "" : (stryCov_9fa48("238"), "Binding stores require a Workspace Scope"));
  }
}
function requireSnapshot(snapshot: MemoryBindingSnapshot): void {
  if (stryMutAct_9fa48("239")) {
    {}
  } else {
    stryCov_9fa48("239");
    if (stryMutAct_9fa48("242") ? (snapshot === null || typeof snapshot !== "object" || JSON.stringify(Object.keys(snapshot).sort()) !== JSON.stringify(["records", "version"]) || snapshot.version !== 1) && !Array.isArray(snapshot.records) : stryMutAct_9fa48("241") ? false : stryMutAct_9fa48("240") ? true : (stryCov_9fa48("240", "241", "242"), (stryMutAct_9fa48("244") ? (snapshot === null || typeof snapshot !== "object" || JSON.stringify(Object.keys(snapshot).sort()) !== JSON.stringify(["records", "version"])) && snapshot.version !== 1 : stryMutAct_9fa48("243") ? false : (stryCov_9fa48("243", "244"), (stryMutAct_9fa48("246") ? (snapshot === null || typeof snapshot !== "object") && JSON.stringify(Object.keys(snapshot).sort()) !== JSON.stringify(["records", "version"]) : stryMutAct_9fa48("245") ? false : (stryCov_9fa48("245", "246"), (stryMutAct_9fa48("248") ? snapshot === null && typeof snapshot !== "object" : stryMutAct_9fa48("247") ? false : (stryCov_9fa48("247", "248"), (stryMutAct_9fa48("250") ? snapshot !== null : stryMutAct_9fa48("249") ? false : (stryCov_9fa48("249", "250"), snapshot === null)) || (stryMutAct_9fa48("252") ? typeof snapshot === "object" : stryMutAct_9fa48("251") ? false : (stryCov_9fa48("251", "252"), typeof snapshot !== (stryMutAct_9fa48("253") ? "" : (stryCov_9fa48("253"), "object")))))) || (stryMutAct_9fa48("255") ? JSON.stringify(Object.keys(snapshot).sort()) === JSON.stringify(["records", "version"]) : stryMutAct_9fa48("254") ? false : (stryCov_9fa48("254", "255"), JSON.stringify(stryMutAct_9fa48("256") ? Object.keys(snapshot) : (stryCov_9fa48("256"), Object.keys(snapshot).sort())) !== JSON.stringify(stryMutAct_9fa48("257") ? [] : (stryCov_9fa48("257"), [stryMutAct_9fa48("258") ? "" : (stryCov_9fa48("258"), "records"), stryMutAct_9fa48("259") ? "" : (stryCov_9fa48("259"), "version")])))))) || (stryMutAct_9fa48("261") ? snapshot.version === 1 : stryMutAct_9fa48("260") ? false : (stryCov_9fa48("260", "261"), snapshot.version !== 1)))) || (stryMutAct_9fa48("262") ? Array.isArray(snapshot.records) : (stryCov_9fa48("262"), !Array.isArray(snapshot.records))))) {
      if (stryMutAct_9fa48("263")) {
        {}
      } else {
        stryCov_9fa48("263");
        throw corruptBindingSnapshot(stryMutAct_9fa48("264") ? "" : (stryCov_9fa48("264"), "Memory Binding snapshot is malformed"));
      }
    }
    for (const record of snapshot.records) {
      if (stryMutAct_9fa48("265")) {
        {}
      } else {
        stryCov_9fa48("265");
        if (stryMutAct_9fa48("268") ? (record === null || typeof record !== "object" || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["bytes", "key"]) || typeof record.key !== "string" || record.key.length === 0) && !(record.bytes instanceof Uint8Array) : stryMutAct_9fa48("267") ? false : stryMutAct_9fa48("266") ? true : (stryCov_9fa48("266", "267", "268"), (stryMutAct_9fa48("270") ? (record === null || typeof record !== "object" || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["bytes", "key"]) || typeof record.key !== "string") && record.key.length === 0 : stryMutAct_9fa48("269") ? false : (stryCov_9fa48("269", "270"), (stryMutAct_9fa48("272") ? (record === null || typeof record !== "object" || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["bytes", "key"])) && typeof record.key !== "string" : stryMutAct_9fa48("271") ? false : (stryCov_9fa48("271", "272"), (stryMutAct_9fa48("274") ? (record === null || typeof record !== "object") && JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["bytes", "key"]) : stryMutAct_9fa48("273") ? false : (stryCov_9fa48("273", "274"), (stryMutAct_9fa48("276") ? record === null && typeof record !== "object" : stryMutAct_9fa48("275") ? false : (stryCov_9fa48("275", "276"), (stryMutAct_9fa48("278") ? record !== null : stryMutAct_9fa48("277") ? false : (stryCov_9fa48("277", "278"), record === null)) || (stryMutAct_9fa48("280") ? typeof record === "object" : stryMutAct_9fa48("279") ? false : (stryCov_9fa48("279", "280"), typeof record !== (stryMutAct_9fa48("281") ? "" : (stryCov_9fa48("281"), "object")))))) || (stryMutAct_9fa48("283") ? JSON.stringify(Object.keys(record).sort()) === JSON.stringify(["bytes", "key"]) : stryMutAct_9fa48("282") ? false : (stryCov_9fa48("282", "283"), JSON.stringify(stryMutAct_9fa48("284") ? Object.keys(record) : (stryCov_9fa48("284"), Object.keys(record).sort())) !== JSON.stringify(stryMutAct_9fa48("285") ? [] : (stryCov_9fa48("285"), [stryMutAct_9fa48("286") ? "" : (stryCov_9fa48("286"), "bytes"), stryMutAct_9fa48("287") ? "" : (stryCov_9fa48("287"), "key")])))))) || (stryMutAct_9fa48("289") ? typeof record.key === "string" : stryMutAct_9fa48("288") ? false : (stryCov_9fa48("288", "289"), typeof record.key !== (stryMutAct_9fa48("290") ? "" : (stryCov_9fa48("290"), "string")))))) || (stryMutAct_9fa48("292") ? record.key.length !== 0 : stryMutAct_9fa48("291") ? false : (stryCov_9fa48("291", "292"), record.key.length === 0)))) || (stryMutAct_9fa48("293") ? record.bytes instanceof Uint8Array : (stryCov_9fa48("293"), !(record.bytes instanceof Uint8Array))))) {
          if (stryMutAct_9fa48("294")) {
            {}
          } else {
            stryCov_9fa48("294");
            throw corruptBindingSnapshot(stryMutAct_9fa48("295") ? "" : (stryCov_9fa48("295"), "Memory Binding snapshot record is malformed"));
          }
        }
      }
    }
  }
}
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (stryMutAct_9fa48("296")) {
    {}
  } else {
    stryCov_9fa48("296");
    return stryMutAct_9fa48("299") ? left.byteLength === right.byteLength || left.every((value, index) => value === right[index]) : stryMutAct_9fa48("298") ? false : stryMutAct_9fa48("297") ? true : (stryCov_9fa48("297", "298", "299"), (stryMutAct_9fa48("301") ? left.byteLength !== right.byteLength : stryMutAct_9fa48("300") ? true : (stryCov_9fa48("300", "301"), left.byteLength === right.byteLength)) && (stryMutAct_9fa48("302") ? left.some((value, index) => value === right[index]) : (stryCov_9fa48("302"), left.every(stryMutAct_9fa48("303") ? () => undefined : (stryCov_9fa48("303"), (value, index) => stryMutAct_9fa48("306") ? value !== right[index] : stryMutAct_9fa48("305") ? false : stryMutAct_9fa48("304") ? true : (stryCov_9fa48("304", "305", "306"), value === right[index]))))));
  }
}
function corruptBindingSnapshot(message: string): AgentCoreError {
  if (stryMutAct_9fa48("307")) {
    {}
  } else {
    stryCov_9fa48("307");
    return new AgentCoreError(stryMutAct_9fa48("308") ? "" : (stryCov_9fa48("308"), "codec.invalid"), message);
  }
}