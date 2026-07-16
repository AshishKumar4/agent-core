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
import { decodeCanonicalJson, encodeCanonicalJson, hasExactJsonKeys, type JsonValue } from "../core";
export type JsonObject = {
  readonly [key: string]: JsonValue;
};
export function requireObject(value: JsonValue | undefined, name: string): JsonObject {
  if (stryMutAct_9fa48("473")) {
    {}
  } else {
    stryCov_9fa48("473");
    if (stryMutAct_9fa48("476") ? (value === undefined || value === null || Array.isArray(value)) && typeof value !== "object" : stryMutAct_9fa48("475") ? false : stryMutAct_9fa48("474") ? true : (stryCov_9fa48("474", "475", "476"), (stryMutAct_9fa48("478") ? (value === undefined || value === null) && Array.isArray(value) : stryMutAct_9fa48("477") ? false : (stryCov_9fa48("477", "478"), (stryMutAct_9fa48("480") ? value === undefined && value === null : stryMutAct_9fa48("479") ? false : (stryCov_9fa48("479", "480"), (stryMutAct_9fa48("482") ? value !== undefined : stryMutAct_9fa48("481") ? false : (stryCov_9fa48("481", "482"), value === undefined)) || (stryMutAct_9fa48("484") ? value !== null : stryMutAct_9fa48("483") ? false : (stryCov_9fa48("483", "484"), value === null)))) || Array.isArray(value))) || (stryMutAct_9fa48("486") ? typeof value === "object" : stryMutAct_9fa48("485") ? false : (stryCov_9fa48("485", "486"), typeof value !== (stryMutAct_9fa48("487") ? "" : (stryCov_9fa48("487"), "object")))))) {
      if (stryMutAct_9fa48("488")) {
        {}
      } else {
        stryCov_9fa48("488");
        throw new TypeError(stryMutAct_9fa48("489") ? `` : (stryCov_9fa48("489"), `${name} must be an object`));
      }
    }
    return value as JsonObject;
  }
}
export function requireExact(object: JsonObject, keys: readonly string[], name: string): void {
  if (stryMutAct_9fa48("490")) {
    {}
  } else {
    stryCov_9fa48("490");
    if (stryMutAct_9fa48("493") ? false : stryMutAct_9fa48("492") ? true : stryMutAct_9fa48("491") ? hasExactJsonKeys(object, keys) : (stryCov_9fa48("491", "492", "493"), !hasExactJsonKeys(object, keys))) {
      if (stryMutAct_9fa48("494")) {
        {}
      } else {
        stryCov_9fa48("494");
        throw new TypeError(stryMutAct_9fa48("495") ? `` : (stryCov_9fa48("495"), `${name} contains missing or unknown fields`));
      }
    }
  }
}
export function requireString(object: JsonObject, key: string, name = key): string {
  if (stryMutAct_9fa48("496")) {
    {}
  } else {
    stryCov_9fa48("496");
    const value = object[key];
    if (stryMutAct_9fa48("499") ? typeof value === "string" : stryMutAct_9fa48("498") ? false : stryMutAct_9fa48("497") ? true : (stryCov_9fa48("497", "498", "499"), typeof value !== (stryMutAct_9fa48("500") ? "" : (stryCov_9fa48("500"), "string")))) {
      if (stryMutAct_9fa48("501")) {
        {}
      } else {
        stryCov_9fa48("501");
        throw new TypeError(stryMutAct_9fa48("502") ? `` : (stryCov_9fa48("502"), `${name} must be a string`));
      }
    }
    return value;
  }
}
export function requireBoolean(object: JsonObject, key: string, name = key): boolean {
  if (stryMutAct_9fa48("503")) {
    {}
  } else {
    stryCov_9fa48("503");
    const value = object[key];
    if (stryMutAct_9fa48("506") ? typeof value === "boolean" : stryMutAct_9fa48("505") ? false : stryMutAct_9fa48("504") ? true : (stryCov_9fa48("504", "505", "506"), typeof value !== (stryMutAct_9fa48("507") ? "" : (stryCov_9fa48("507"), "boolean")))) {
      if (stryMutAct_9fa48("508")) {
        {}
      } else {
        stryCov_9fa48("508");
        throw new TypeError(stryMutAct_9fa48("509") ? `` : (stryCov_9fa48("509"), `${name} must be a boolean`));
      }
    }
    return value;
  }
}
export function requireSafeInteger(object: JsonObject, key: string, name = key): number {
  if (stryMutAct_9fa48("510")) {
    {}
  } else {
    stryCov_9fa48("510");
    const value = object[key];
    if (stryMutAct_9fa48("513") ? (typeof value !== "number" || !Number.isSafeInteger(value)) && value < 0 : stryMutAct_9fa48("512") ? false : stryMutAct_9fa48("511") ? true : (stryCov_9fa48("511", "512", "513"), (stryMutAct_9fa48("515") ? typeof value !== "number" && !Number.isSafeInteger(value) : stryMutAct_9fa48("514") ? false : (stryCov_9fa48("514", "515"), (stryMutAct_9fa48("517") ? typeof value === "number" : stryMutAct_9fa48("516") ? false : (stryCov_9fa48("516", "517"), typeof value !== (stryMutAct_9fa48("518") ? "" : (stryCov_9fa48("518"), "number")))) || (stryMutAct_9fa48("519") ? Number.isSafeInteger(value) : (stryCov_9fa48("519"), !Number.isSafeInteger(value))))) || (stryMutAct_9fa48("522") ? value >= 0 : stryMutAct_9fa48("521") ? value <= 0 : stryMutAct_9fa48("520") ? false : (stryCov_9fa48("520", "521", "522"), value < 0)))) {
      if (stryMutAct_9fa48("523")) {
        {}
      } else {
        stryCov_9fa48("523");
        throw new TypeError(stryMutAct_9fa48("524") ? `` : (stryCov_9fa48("524"), `${name} must be a non-negative safe integer`));
      }
    }
    return value;
  }
}
export function requireArray(value: JsonValue | undefined, name: string): readonly JsonValue[] {
  if (stryMutAct_9fa48("525")) {
    {}
  } else {
    stryCov_9fa48("525");
    if (stryMutAct_9fa48("528") ? false : stryMutAct_9fa48("527") ? true : stryMutAct_9fa48("526") ? Array.isArray(value) : (stryCov_9fa48("526", "527", "528"), !Array.isArray(value))) {
      if (stryMutAct_9fa48("529")) {
        {}
      } else {
        stryCov_9fa48("529");
        throw new TypeError(stryMutAct_9fa48("530") ? `` : (stryCov_9fa48("530"), `${name} must be an array`));
      }
    }
    return value;
  }
}
export function canonicalJson<Value extends JsonValue>(value: Value): Value {
  if (stryMutAct_9fa48("531")) {
    {}
  } else {
    stryCov_9fa48("531");
    return deepFreeze(decodeCanonicalJson(encodeCanonicalJson(value)) as Value);
  }
}
export function canonicalJsonEqual(left: JsonValue, right: JsonValue): boolean {
  if (stryMutAct_9fa48("532")) {
    {}
  } else {
    stryCov_9fa48("532");
    return bytesEqual(encodeCanonicalJson(left), encodeCanonicalJson(right));
  }
}
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (stryMutAct_9fa48("533")) {
    {}
  } else {
    stryCov_9fa48("533");
    return stryMutAct_9fa48("536") ? left.byteLength === right.byteLength || left.every((value, index) => value === right[index]) : stryMutAct_9fa48("535") ? false : stryMutAct_9fa48("534") ? true : (stryCov_9fa48("534", "535", "536"), (stryMutAct_9fa48("538") ? left.byteLength !== right.byteLength : stryMutAct_9fa48("537") ? true : (stryCov_9fa48("537", "538"), left.byteLength === right.byteLength)) && (stryMutAct_9fa48("539") ? left.some((value, index) => value === right[index]) : (stryCov_9fa48("539"), left.every(stryMutAct_9fa48("540") ? () => undefined : (stryCov_9fa48("540"), (value, index) => stryMutAct_9fa48("543") ? value !== right[index] : stryMutAct_9fa48("542") ? false : stryMutAct_9fa48("541") ? true : (stryCov_9fa48("541", "542", "543"), value === right[index]))))));
  }
}
function deepFreeze<Value>(value: Value): Value {
  if (stryMutAct_9fa48("544")) {
    {}
  } else {
    stryCov_9fa48("544");
    if (stryMutAct_9fa48("547") ? value !== null || typeof value === "object" : stryMutAct_9fa48("546") ? false : stryMutAct_9fa48("545") ? true : (stryCov_9fa48("545", "546", "547"), (stryMutAct_9fa48("549") ? value === null : stryMutAct_9fa48("548") ? true : (stryCov_9fa48("548", "549"), value !== null)) && (stryMutAct_9fa48("551") ? typeof value !== "object" : stryMutAct_9fa48("550") ? true : (stryCov_9fa48("550", "551"), typeof value === (stryMutAct_9fa48("552") ? "" : (stryCov_9fa48("552"), "object")))))) {
      if (stryMutAct_9fa48("553")) {
        {}
      } else {
        stryCov_9fa48("553");
        Object.freeze(value);
        for (const child of Object.values(value)) {
          if (stryMutAct_9fa48("554")) {
            {}
          } else {
            stryCov_9fa48("554");
            deepFreeze(child);
          }
        }
      }
    }
    return value;
  }
}