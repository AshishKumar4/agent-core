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
import { RecordCodec, Revision, type JsonValue } from "../core";
import { AgentCoreError } from "../errors";
import { BindingName, FacetRef, ProtectionDomain } from "../facets";
import type { ScopeRef, SubjectRef } from "../identity";
import { requireExact, requireObject, requireSafeInteger, requireString, type JsonObject } from "./data";
import { GrantId } from "./id";
import { decodeAuthorityScope, decodeAuthoritySubject, encodeAuthorityScope, encodeAuthoritySubject, scopeKey, subjectKey } from "./reference";
import { authorityKey } from "./key";
export type BindingStateName = "active" | "inactive";
abstract class BindingLifecycle {
  public abstract readonly name: BindingStateName;
  public abstract activate(): BindingLifecycle;
  public abstract deactivate(): BindingLifecycle;
  public static from(state: BindingStateName): BindingLifecycle {
    if (stryMutAct_9fa48("0")) {
      {}
    } else {
      stryCov_9fa48("0");
      return (stryMutAct_9fa48("3") ? state !== "active" : stryMutAct_9fa48("2") ? false : stryMutAct_9fa48("1") ? true : (stryCov_9fa48("1", "2", "3"), state === (stryMutAct_9fa48("4") ? "" : (stryCov_9fa48("4"), "active")))) ? activeBinding : inactiveBinding;
    }
  }
}
class ActiveBindingLifecycle extends BindingLifecycle {
  public readonly name = "active" as const;
  public activate(): BindingLifecycle {
    if (stryMutAct_9fa48("5")) {
      {}
    } else {
      stryCov_9fa48("5");
      return this;
    }
  }
  public deactivate(): BindingLifecycle {
    if (stryMutAct_9fa48("6")) {
      {}
    } else {
      stryCov_9fa48("6");
      return inactiveBinding;
    }
  }
}
class InactiveBindingLifecycle extends BindingLifecycle {
  public readonly name = "inactive" as const;
  public activate(): BindingLifecycle {
    if (stryMutAct_9fa48("7")) {
      {}
    } else {
      stryCov_9fa48("7");
      return activeBinding;
    }
  }
  public deactivate(): BindingLifecycle {
    if (stryMutAct_9fa48("8")) {
      {}
    } else {
      stryCov_9fa48("8");
      return this;
    }
  }
}
const activeBinding = Object.freeze(new ActiveBindingLifecycle());
const inactiveBinding = Object.freeze(new InactiveBindingLifecycle());
class BindingCodecV1 extends RecordCodec<Binding> {
  public constructor() {
    if (stryMutAct_9fa48("9")) {
      {}
    } else {
      stryCov_9fa48("9");
      super(stryMutAct_9fa48("10") ? "" : (stryCov_9fa48("10"), "authority.binding"), stryMutAct_9fa48("11") ? {} : (stryCov_9fa48("11"), {
        major: 1,
        minor: 0
      }));
    }
  }
  protected encodePayload(record: Binding): JsonValue {
    if (stryMutAct_9fa48("12")) {
      {}
    } else {
      stryCov_9fa48("12");
      return record.toData();
    }
  }
  protected decodePayload(payload: JsonValue): Binding {
    if (stryMutAct_9fa48("13")) {
      {}
    } else {
      stryCov_9fa48("13");
      return Binding.fromData(payload);
    }
  }
}
export class Binding {
  public static readonly codec: RecordCodec<Binding> = new BindingCodecV1();
  public readonly domain: ProtectionDomain;
  public readonly subject: SubjectRef;
  readonly #lifecycle: BindingLifecycle;
  public constructor(public readonly scope: ScopeRef, subject: SubjectRef, domain: ProtectionDomain, public readonly name: BindingName, public readonly grantId: GrantId, public readonly facet: FacetRef, public readonly generation: number, state: BindingStateName, public readonly revision: Revision) {
    if (stryMutAct_9fa48("14")) {
      {}
    } else {
      stryCov_9fa48("14");
      if (stryMutAct_9fa48("17") ? scope.kind === "workspace" : stryMutAct_9fa48("16") ? false : stryMutAct_9fa48("15") ? true : (stryCov_9fa48("15", "16", "17"), scope.kind !== (stryMutAct_9fa48("18") ? "" : (stryCov_9fa48("18"), "workspace")))) {
        if (stryMutAct_9fa48("19")) {
          {}
        } else {
          stryCov_9fa48("19");
          throw new TypeError(stryMutAct_9fa48("20") ? "" : (stryCov_9fa48("20"), "Bindings require a Workspace Scope"));
        }
      }
      if (stryMutAct_9fa48("23") ? !Number.isSafeInteger(generation) && generation < 0 : stryMutAct_9fa48("22") ? false : stryMutAct_9fa48("21") ? true : (stryCov_9fa48("21", "22", "23"), (stryMutAct_9fa48("24") ? Number.isSafeInteger(generation) : (stryCov_9fa48("24"), !Number.isSafeInteger(generation))) || (stryMutAct_9fa48("27") ? generation >= 0 : stryMutAct_9fa48("26") ? generation <= 0 : stryMutAct_9fa48("25") ? false : (stryCov_9fa48("25", "26", "27"), generation < 0)))) {
        if (stryMutAct_9fa48("28")) {
          {}
        } else {
          stryCov_9fa48("28");
          throw new TypeError(stryMutAct_9fa48("29") ? "" : (stryCov_9fa48("29"), "Binding generation must be a non-negative safe integer"));
        }
      }
      this.#lifecycle = BindingLifecycle.from(requireBindingState(state));
      this.subject = decodeAuthoritySubject(encodeAuthoritySubject(subject));
      this.domain = immutableDomain(domain);
      Object.freeze(this);
    }
  }
  public static active(scope: ScopeRef, subject: SubjectRef, domain: ProtectionDomain, name: BindingName, grantId: GrantId, facet: FacetRef): Binding {
    if (stryMutAct_9fa48("30")) {
      {}
    } else {
      stryCov_9fa48("30");
      return new Binding(scope, subject, domain, name, grantId, facet, 0, stryMutAct_9fa48("31") ? "" : (stryCov_9fa48("31"), "active"), Revision.initial());
    }
  }
  public static encode(record: Binding): Uint8Array {
    if (stryMutAct_9fa48("32")) {
      {}
    } else {
      stryCov_9fa48("32");
      return Binding.codec.encode(record);
    }
  }
  public static decode(bytes: Uint8Array): Binding {
    if (stryMutAct_9fa48("33")) {
      {}
    } else {
      stryCov_9fa48("33");
      return Binding.codec.decode(bytes);
    }
  }
  public get key(): string {
    if (stryMutAct_9fa48("34")) {
      {}
    } else {
      stryCov_9fa48("34");
      return authorityKey(stryMutAct_9fa48("35") ? "" : (stryCov_9fa48("35"), "binding"), stryMutAct_9fa48("36") ? [] : (stryCov_9fa48("36"), [encodeAuthorityScope(this.scope), encodeAuthoritySubject(this.subject), encodeDomain(this.domain), this.name.value]));
    }
  }
  public get resolves(): boolean {
    if (stryMutAct_9fa48("37")) {
      {}
    } else {
      stryCov_9fa48("37");
      return stryMutAct_9fa48("40") ? this.state !== "active" : stryMutAct_9fa48("39") ? false : stryMutAct_9fa48("38") ? true : (stryCov_9fa48("38", "39", "40"), this.state === (stryMutAct_9fa48("41") ? "" : (stryCov_9fa48("41"), "active")));
    }
  }
  public get state(): BindingStateName {
    if (stryMutAct_9fa48("42")) {
      {}
    } else {
      stryCov_9fa48("42");
      return this.#lifecycle.name;
    }
  }
  public replace(grantId: GrantId, facet: FacetRef): Binding {
    if (stryMutAct_9fa48("43")) {
      {}
    } else {
      stryCov_9fa48("43");
      return this.transition(this.#lifecycle.activate(), grantId, facet);
    }
  }
  public deactivate(): Binding {
    if (stryMutAct_9fa48("44")) {
      {}
    } else {
      stryCov_9fa48("44");
      const next = this.#lifecycle.deactivate();
      return (stryMutAct_9fa48("47") ? next !== this.#lifecycle : stryMutAct_9fa48("46") ? false : stryMutAct_9fa48("45") ? true : (stryCov_9fa48("45", "46", "47"), next === this.#lifecycle)) ? this : this.transition(next, this.grantId, this.facet);
    }
  }
  public assertCanReplace(next: Binding): void {
    if (stryMutAct_9fa48("48")) {
      {}
    } else {
      stryCov_9fa48("48");
      if (stryMutAct_9fa48("51") ? (this.key !== next.key || scopeKey(this.scope) !== scopeKey(next.scope) || subjectKey(this.subject) !== subjectKey(next.subject) || next.generation !== this.generation + 1) && next.revision.value !== this.revision.value + 1 : stryMutAct_9fa48("50") ? false : stryMutAct_9fa48("49") ? true : (stryCov_9fa48("49", "50", "51"), (stryMutAct_9fa48("53") ? (this.key !== next.key || scopeKey(this.scope) !== scopeKey(next.scope) || subjectKey(this.subject) !== subjectKey(next.subject)) && next.generation !== this.generation + 1 : stryMutAct_9fa48("52") ? false : (stryCov_9fa48("52", "53"), (stryMutAct_9fa48("55") ? (this.key !== next.key || scopeKey(this.scope) !== scopeKey(next.scope)) && subjectKey(this.subject) !== subjectKey(next.subject) : stryMutAct_9fa48("54") ? false : (stryCov_9fa48("54", "55"), (stryMutAct_9fa48("57") ? this.key !== next.key && scopeKey(this.scope) !== scopeKey(next.scope) : stryMutAct_9fa48("56") ? false : (stryCov_9fa48("56", "57"), (stryMutAct_9fa48("59") ? this.key === next.key : stryMutAct_9fa48("58") ? false : (stryCov_9fa48("58", "59"), this.key !== next.key)) || (stryMutAct_9fa48("61") ? scopeKey(this.scope) === scopeKey(next.scope) : stryMutAct_9fa48("60") ? false : (stryCov_9fa48("60", "61"), scopeKey(this.scope) !== scopeKey(next.scope))))) || (stryMutAct_9fa48("63") ? subjectKey(this.subject) === subjectKey(next.subject) : stryMutAct_9fa48("62") ? false : (stryCov_9fa48("62", "63"), subjectKey(this.subject) !== subjectKey(next.subject))))) || (stryMutAct_9fa48("65") ? next.generation === this.generation + 1 : stryMutAct_9fa48("64") ? false : (stryCov_9fa48("64", "65"), next.generation !== (stryMutAct_9fa48("66") ? this.generation - 1 : (stryCov_9fa48("66"), this.generation + 1)))))) || (stryMutAct_9fa48("68") ? next.revision.value === this.revision.value + 1 : stryMutAct_9fa48("67") ? false : (stryCov_9fa48("67", "68"), next.revision.value !== (stryMutAct_9fa48("69") ? this.revision.value - 1 : (stryCov_9fa48("69"), this.revision.value + 1)))))) {
        if (stryMutAct_9fa48("70")) {
          {}
        } else {
          stryCov_9fa48("70");
          throw new AgentCoreError(stryMutAct_9fa48("71") ? "" : (stryCov_9fa48("71"), "binding.invalid"), stryMutAct_9fa48("72") ? "" : (stryCov_9fa48("72"), "Binding updates require immutable identity and the next generation and revision"));
        }
      }
    }
  }
  public toData(): JsonObject {
    if (stryMutAct_9fa48("73")) {
      {}
    } else {
      stryCov_9fa48("73");
      return stryMutAct_9fa48("74") ? {} : (stryCov_9fa48("74"), {
        domain: encodeDomain(this.domain),
        facet: this.facet.value,
        generation: this.generation,
        grantId: this.grantId.value,
        name: this.name.value,
        revision: this.revision.value,
        scope: encodeAuthorityScope(this.scope),
        state: this.state,
        subject: encodeAuthoritySubject(this.subject)
      });
    }
  }
  public static fromData(value: JsonValue | undefined): Binding {
    if (stryMutAct_9fa48("75")) {
      {}
    } else {
      stryCov_9fa48("75");
      const object = requireObject(value, stryMutAct_9fa48("76") ? "" : (stryCov_9fa48("76"), "Binding"));
      requireExact(object, stryMutAct_9fa48("77") ? [] : (stryCov_9fa48("77"), [stryMutAct_9fa48("78") ? "" : (stryCov_9fa48("78"), "domain"), stryMutAct_9fa48("79") ? "" : (stryCov_9fa48("79"), "facet"), stryMutAct_9fa48("80") ? "" : (stryCov_9fa48("80"), "generation"), stryMutAct_9fa48("81") ? "" : (stryCov_9fa48("81"), "grantId"), stryMutAct_9fa48("82") ? "" : (stryCov_9fa48("82"), "name"), stryMutAct_9fa48("83") ? "" : (stryCov_9fa48("83"), "revision"), stryMutAct_9fa48("84") ? "" : (stryCov_9fa48("84"), "scope"), stryMutAct_9fa48("85") ? "" : (stryCov_9fa48("85"), "state"), stryMutAct_9fa48("86") ? "" : (stryCov_9fa48("86"), "subject")]), stryMutAct_9fa48("87") ? "" : (stryCov_9fa48("87"), "Binding"));
      return new Binding(decodeAuthorityScope(object[stryMutAct_9fa48("88") ? "" : (stryCov_9fa48("88"), "scope")]!), decodeAuthoritySubject(object[stryMutAct_9fa48("89") ? "" : (stryCov_9fa48("89"), "subject")]!), decodeDomain(object[stryMutAct_9fa48("90") ? "" : (stryCov_9fa48("90"), "domain")]), new BindingName(requireString(object, stryMutAct_9fa48("91") ? "" : (stryCov_9fa48("91"), "name"), stryMutAct_9fa48("92") ? "" : (stryCov_9fa48("92"), "Binding name"))), new GrantId(requireString(object, stryMutAct_9fa48("93") ? "" : (stryCov_9fa48("93"), "grantId"), stryMutAct_9fa48("94") ? "" : (stryCov_9fa48("94"), "Grant ID"))), new FacetRef(requireString(object, stryMutAct_9fa48("95") ? "" : (stryCov_9fa48("95"), "facet"), stryMutAct_9fa48("96") ? "" : (stryCov_9fa48("96"), "Facet reference"))), requireSafeInteger(object, stryMutAct_9fa48("97") ? "" : (stryCov_9fa48("97"), "generation"), stryMutAct_9fa48("98") ? "" : (stryCov_9fa48("98"), "Binding generation")), requireBindingState(object[stryMutAct_9fa48("99") ? "" : (stryCov_9fa48("99"), "state")]), new Revision(requireSafeInteger(object, stryMutAct_9fa48("100") ? "" : (stryCov_9fa48("100"), "revision"), stryMutAct_9fa48("101") ? "" : (stryCov_9fa48("101"), "Binding revision"))));
    }
  }
  private transition(state: BindingLifecycle, grantId: GrantId, facet: FacetRef): Binding {
    if (stryMutAct_9fa48("102")) {
      {}
    } else {
      stryCov_9fa48("102");
      if (stryMutAct_9fa48("105") ? this.generation === Number.MAX_SAFE_INTEGER && this.revision.value === Number.MAX_SAFE_INTEGER : stryMutAct_9fa48("104") ? false : stryMutAct_9fa48("103") ? true : (stryCov_9fa48("103", "104", "105"), (stryMutAct_9fa48("107") ? this.generation !== Number.MAX_SAFE_INTEGER : stryMutAct_9fa48("106") ? false : (stryCov_9fa48("106", "107"), this.generation === Number.MAX_SAFE_INTEGER)) || (stryMutAct_9fa48("109") ? this.revision.value !== Number.MAX_SAFE_INTEGER : stryMutAct_9fa48("108") ? false : (stryCov_9fa48("108", "109"), this.revision.value === Number.MAX_SAFE_INTEGER)))) {
        if (stryMutAct_9fa48("110")) {
          {}
        } else {
          stryCov_9fa48("110");
          throw new AgentCoreError(stryMutAct_9fa48("111") ? "" : (stryCov_9fa48("111"), "binding.invalid"), stryMutAct_9fa48("112") ? "" : (stryCov_9fa48("112"), "Binding generation is exhausted"));
        }
      }
      return new Binding(this.scope, this.subject, this.domain, this.name, grantId, facet, stryMutAct_9fa48("113") ? this.generation - 1 : (stryCov_9fa48("113"), this.generation + 1), state.name, this.revision.next());
    }
  }
}
export function encodeDomain(domain: ProtectionDomain): JsonObject {
  if (stryMutAct_9fa48("114")) {
    {}
  } else {
    stryCov_9fa48("114");
    return stryMutAct_9fa48("115") ? {} : (stryCov_9fa48("115"), {
      kind: domain.kind,
      label: domain.label,
      secretPolicy: domain.secretPolicy
    });
  }
}
export function domainKey(domain: ProtectionDomain): string {
  if (stryMutAct_9fa48("116")) {
    {}
  } else {
    stryCov_9fa48("116");
    return authorityKey(stryMutAct_9fa48("117") ? "" : (stryCov_9fa48("117"), "domain"), stryMutAct_9fa48("118") ? [] : (stryCov_9fa48("118"), [encodeDomain(domain)]));
  }
}
function immutableDomain(domain: ProtectionDomain): ProtectionDomain {
  if (stryMutAct_9fa48("119")) {
    {}
  } else {
    stryCov_9fa48("119");
    return Object.freeze(new ProtectionDomain(domain.kind, domain.label, domain.secretPolicy));
  }
}
export function decodeDomain(value: JsonValue | undefined): ProtectionDomain {
  if (stryMutAct_9fa48("120")) {
    {}
  } else {
    stryCov_9fa48("120");
    const object = requireObject(value, stryMutAct_9fa48("121") ? "" : (stryCov_9fa48("121"), "Protection domain"));
    requireExact(object, stryMutAct_9fa48("122") ? [] : (stryCov_9fa48("122"), [stryMutAct_9fa48("123") ? "" : (stryCov_9fa48("123"), "kind"), stryMutAct_9fa48("124") ? "" : (stryCov_9fa48("124"), "label"), stryMutAct_9fa48("125") ? "" : (stryCov_9fa48("125"), "secretPolicy")]), stryMutAct_9fa48("126") ? "" : (stryCov_9fa48("126"), "Protection domain"));
    const kind = object[stryMutAct_9fa48("127") ? "" : (stryCov_9fa48("127"), "kind")];
    const secretPolicy = object[stryMutAct_9fa48("128") ? "" : (stryCov_9fa48("128"), "secretPolicy")];
    if (stryMutAct_9fa48("131") ? kind !== "frontend" || kind !== "backend" : stryMutAct_9fa48("130") ? false : stryMutAct_9fa48("129") ? true : (stryCov_9fa48("129", "130", "131"), (stryMutAct_9fa48("133") ? kind === "frontend" : stryMutAct_9fa48("132") ? true : (stryCov_9fa48("132", "133"), kind !== (stryMutAct_9fa48("134") ? "" : (stryCov_9fa48("134"), "frontend")))) && (stryMutAct_9fa48("136") ? kind === "backend" : stryMutAct_9fa48("135") ? true : (stryCov_9fa48("135", "136"), kind !== (stryMutAct_9fa48("137") ? "" : (stryCov_9fa48("137"), "backend")))))) {
      if (stryMutAct_9fa48("138")) {
        {}
      } else {
        stryCov_9fa48("138");
        throw new TypeError(stryMutAct_9fa48("139") ? "" : (stryCov_9fa48("139"), "Protection domain kind is invalid"));
      }
    }
    if (stryMutAct_9fa48("142") ? secretPolicy !== "no-secrets" || secretPolicy !== "may-hold-secrets" : stryMutAct_9fa48("141") ? false : stryMutAct_9fa48("140") ? true : (stryCov_9fa48("140", "141", "142"), (stryMutAct_9fa48("144") ? secretPolicy === "no-secrets" : stryMutAct_9fa48("143") ? true : (stryCov_9fa48("143", "144"), secretPolicy !== (stryMutAct_9fa48("145") ? "" : (stryCov_9fa48("145"), "no-secrets")))) && (stryMutAct_9fa48("147") ? secretPolicy === "may-hold-secrets" : stryMutAct_9fa48("146") ? true : (stryCov_9fa48("146", "147"), secretPolicy !== (stryMutAct_9fa48("148") ? "" : (stryCov_9fa48("148"), "may-hold-secrets")))))) {
      if (stryMutAct_9fa48("149")) {
        {}
      } else {
        stryCov_9fa48("149");
        throw new TypeError(stryMutAct_9fa48("150") ? "" : (stryCov_9fa48("150"), "Protection domain secret policy is invalid"));
      }
    }
    return new ProtectionDomain(kind, requireString(object, stryMutAct_9fa48("151") ? "" : (stryCov_9fa48("151"), "label"), stryMutAct_9fa48("152") ? "" : (stryCov_9fa48("152"), "Protection domain label")), secretPolicy);
  }
}
function requireBindingState(value: JsonValue | undefined): BindingStateName {
  if (stryMutAct_9fa48("153")) {
    {}
  } else {
    stryCov_9fa48("153");
    if (stryMutAct_9fa48("156") ? value === "active" && value === "inactive" : stryMutAct_9fa48("155") ? false : stryMutAct_9fa48("154") ? true : (stryCov_9fa48("154", "155", "156"), (stryMutAct_9fa48("158") ? value !== "active" : stryMutAct_9fa48("157") ? false : (stryCov_9fa48("157", "158"), value === (stryMutAct_9fa48("159") ? "" : (stryCov_9fa48("159"), "active")))) || (stryMutAct_9fa48("161") ? value !== "inactive" : stryMutAct_9fa48("160") ? false : (stryCov_9fa48("160", "161"), value === (stryMutAct_9fa48("162") ? "" : (stryCov_9fa48("162"), "inactive")))))) return value;
    throw new TypeError(stryMutAct_9fa48("163") ? "" : (stryCov_9fa48("163"), "Binding state is invalid"));
  }
}