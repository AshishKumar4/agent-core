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
    if (stryMutAct_9fa48("309")) {
      {}
    } else {
      stryCov_9fa48("309");
      return (stryMutAct_9fa48("312") ? state !== "active" : stryMutAct_9fa48("311") ? false : stryMutAct_9fa48("310") ? true : (stryCov_9fa48("310", "311", "312"), state === (stryMutAct_9fa48("313") ? "" : (stryCov_9fa48("313"), "active")))) ? activeBinding : inactiveBinding;
    }
  }
}
class ActiveBindingLifecycle extends BindingLifecycle {
  public readonly name = "active" as const;
  public activate(): BindingLifecycle {
    if (stryMutAct_9fa48("314")) {
      {}
    } else {
      stryCov_9fa48("314");
      return this;
    }
  }
  public deactivate(): BindingLifecycle {
    if (stryMutAct_9fa48("315")) {
      {}
    } else {
      stryCov_9fa48("315");
      return inactiveBinding;
    }
  }
}
class InactiveBindingLifecycle extends BindingLifecycle {
  public readonly name = "inactive" as const;
  public activate(): BindingLifecycle {
    if (stryMutAct_9fa48("316")) {
      {}
    } else {
      stryCov_9fa48("316");
      return activeBinding;
    }
  }
  public deactivate(): BindingLifecycle {
    if (stryMutAct_9fa48("317")) {
      {}
    } else {
      stryCov_9fa48("317");
      return this;
    }
  }
}
const activeBinding = Object.freeze(new ActiveBindingLifecycle());
const inactiveBinding = Object.freeze(new InactiveBindingLifecycle());
class BindingCodecV1 extends RecordCodec<Binding> {
  public constructor() {
    if (stryMutAct_9fa48("318")) {
      {}
    } else {
      stryCov_9fa48("318");
      super(stryMutAct_9fa48("319") ? "" : (stryCov_9fa48("319"), "authority.binding"), stryMutAct_9fa48("320") ? {} : (stryCov_9fa48("320"), {
        major: 1,
        minor: 0
      }));
    }
  }
  protected encodePayload(record: Binding): JsonValue {
    if (stryMutAct_9fa48("321")) {
      {}
    } else {
      stryCov_9fa48("321");
      return record.toData();
    }
  }
  protected decodePayload(payload: JsonValue): Binding {
    if (stryMutAct_9fa48("322")) {
      {}
    } else {
      stryCov_9fa48("322");
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
    if (stryMutAct_9fa48("323")) {
      {}
    } else {
      stryCov_9fa48("323");
      if (stryMutAct_9fa48("326") ? scope.kind === "workspace" : stryMutAct_9fa48("325") ? false : stryMutAct_9fa48("324") ? true : (stryCov_9fa48("324", "325", "326"), scope.kind !== (stryMutAct_9fa48("327") ? "" : (stryCov_9fa48("327"), "workspace")))) {
        if (stryMutAct_9fa48("328")) {
          {}
        } else {
          stryCov_9fa48("328");
          throw new TypeError(stryMutAct_9fa48("329") ? "" : (stryCov_9fa48("329"), "Bindings require a Workspace Scope"));
        }
      }
      if (stryMutAct_9fa48("332") ? !Number.isSafeInteger(generation) && generation < 0 : stryMutAct_9fa48("331") ? false : stryMutAct_9fa48("330") ? true : (stryCov_9fa48("330", "331", "332"), (stryMutAct_9fa48("333") ? Number.isSafeInteger(generation) : (stryCov_9fa48("333"), !Number.isSafeInteger(generation))) || (stryMutAct_9fa48("336") ? generation >= 0 : stryMutAct_9fa48("335") ? generation <= 0 : stryMutAct_9fa48("334") ? false : (stryCov_9fa48("334", "335", "336"), generation < 0)))) {
        if (stryMutAct_9fa48("337")) {
          {}
        } else {
          stryCov_9fa48("337");
          throw new TypeError(stryMutAct_9fa48("338") ? "" : (stryCov_9fa48("338"), "Binding generation must be a non-negative safe integer"));
        }
      }
      this.#lifecycle = BindingLifecycle.from(requireBindingState(state));
      this.subject = decodeAuthoritySubject(encodeAuthoritySubject(subject));
      this.domain = immutableDomain(domain);
      Object.freeze(this);
    }
  }
  public static active(scope: ScopeRef, subject: SubjectRef, domain: ProtectionDomain, name: BindingName, grantId: GrantId, facet: FacetRef): Binding {
    if (stryMutAct_9fa48("339")) {
      {}
    } else {
      stryCov_9fa48("339");
      return new Binding(scope, subject, domain, name, grantId, facet, 0, stryMutAct_9fa48("340") ? "" : (stryCov_9fa48("340"), "active"), Revision.initial());
    }
  }
  public static encode(record: Binding): Uint8Array {
    if (stryMutAct_9fa48("341")) {
      {}
    } else {
      stryCov_9fa48("341");
      return Binding.codec.encode(record);
    }
  }
  public static decode(bytes: Uint8Array): Binding {
    if (stryMutAct_9fa48("342")) {
      {}
    } else {
      stryCov_9fa48("342");
      return Binding.codec.decode(bytes);
    }
  }
  public get key(): string {
    if (stryMutAct_9fa48("343")) {
      {}
    } else {
      stryCov_9fa48("343");
      return authorityKey(stryMutAct_9fa48("344") ? "" : (stryCov_9fa48("344"), "binding"), stryMutAct_9fa48("345") ? [] : (stryCov_9fa48("345"), [encodeAuthorityScope(this.scope), encodeAuthoritySubject(this.subject), encodeDomain(this.domain), this.name.value]));
    }
  }
  public get resolves(): boolean {
    if (stryMutAct_9fa48("346")) {
      {}
    } else {
      stryCov_9fa48("346");
      return stryMutAct_9fa48("349") ? this.state !== "active" : stryMutAct_9fa48("348") ? false : stryMutAct_9fa48("347") ? true : (stryCov_9fa48("347", "348", "349"), this.state === (stryMutAct_9fa48("350") ? "" : (stryCov_9fa48("350"), "active")));
    }
  }
  public get state(): BindingStateName {
    if (stryMutAct_9fa48("351")) {
      {}
    } else {
      stryCov_9fa48("351");
      return this.#lifecycle.name;
    }
  }
  public replace(grantId: GrantId, facet: FacetRef): Binding {
    if (stryMutAct_9fa48("352")) {
      {}
    } else {
      stryCov_9fa48("352");
      return this.transition(this.#lifecycle.activate(), grantId, facet);
    }
  }
  public deactivate(): Binding {
    if (stryMutAct_9fa48("353")) {
      {}
    } else {
      stryCov_9fa48("353");
      const next = this.#lifecycle.deactivate();
      return (stryMutAct_9fa48("356") ? next !== this.#lifecycle : stryMutAct_9fa48("355") ? false : stryMutAct_9fa48("354") ? true : (stryCov_9fa48("354", "355", "356"), next === this.#lifecycle)) ? this : this.transition(next, this.grantId, this.facet);
    }
  }
  public assertCanReplace(next: Binding): void {
    if (stryMutAct_9fa48("357")) {
      {}
    } else {
      stryCov_9fa48("357");
      if (stryMutAct_9fa48("360") ? (this.key !== next.key || scopeKey(this.scope) !== scopeKey(next.scope) || subjectKey(this.subject) !== subjectKey(next.subject) || next.generation !== this.generation + 1) && next.revision.value !== this.revision.value + 1 : stryMutAct_9fa48("359") ? false : stryMutAct_9fa48("358") ? true : (stryCov_9fa48("358", "359", "360"), (stryMutAct_9fa48("362") ? (this.key !== next.key || scopeKey(this.scope) !== scopeKey(next.scope) || subjectKey(this.subject) !== subjectKey(next.subject)) && next.generation !== this.generation + 1 : stryMutAct_9fa48("361") ? false : (stryCov_9fa48("361", "362"), (stryMutAct_9fa48("364") ? (this.key !== next.key || scopeKey(this.scope) !== scopeKey(next.scope)) && subjectKey(this.subject) !== subjectKey(next.subject) : stryMutAct_9fa48("363") ? false : (stryCov_9fa48("363", "364"), (stryMutAct_9fa48("366") ? this.key !== next.key && scopeKey(this.scope) !== scopeKey(next.scope) : stryMutAct_9fa48("365") ? false : (stryCov_9fa48("365", "366"), (stryMutAct_9fa48("368") ? this.key === next.key : stryMutAct_9fa48("367") ? false : (stryCov_9fa48("367", "368"), this.key !== next.key)) || (stryMutAct_9fa48("370") ? scopeKey(this.scope) === scopeKey(next.scope) : stryMutAct_9fa48("369") ? false : (stryCov_9fa48("369", "370"), scopeKey(this.scope) !== scopeKey(next.scope))))) || (stryMutAct_9fa48("372") ? subjectKey(this.subject) === subjectKey(next.subject) : stryMutAct_9fa48("371") ? false : (stryCov_9fa48("371", "372"), subjectKey(this.subject) !== subjectKey(next.subject))))) || (stryMutAct_9fa48("374") ? next.generation === this.generation + 1 : stryMutAct_9fa48("373") ? false : (stryCov_9fa48("373", "374"), next.generation !== (stryMutAct_9fa48("375") ? this.generation - 1 : (stryCov_9fa48("375"), this.generation + 1)))))) || (stryMutAct_9fa48("377") ? next.revision.value === this.revision.value + 1 : stryMutAct_9fa48("376") ? false : (stryCov_9fa48("376", "377"), next.revision.value !== (stryMutAct_9fa48("378") ? this.revision.value - 1 : (stryCov_9fa48("378"), this.revision.value + 1)))))) {
        if (stryMutAct_9fa48("379")) {
          {}
        } else {
          stryCov_9fa48("379");
          throw new AgentCoreError(stryMutAct_9fa48("380") ? "" : (stryCov_9fa48("380"), "binding.invalid"), stryMutAct_9fa48("381") ? "" : (stryCov_9fa48("381"), "Binding updates require immutable identity and the next generation and revision"));
        }
      }
    }
  }
  public toData(): JsonObject {
    if (stryMutAct_9fa48("382")) {
      {}
    } else {
      stryCov_9fa48("382");
      return stryMutAct_9fa48("383") ? {} : (stryCov_9fa48("383"), {
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
    if (stryMutAct_9fa48("384")) {
      {}
    } else {
      stryCov_9fa48("384");
      const object = requireObject(value, stryMutAct_9fa48("385") ? "" : (stryCov_9fa48("385"), "Binding"));
      requireExact(object, stryMutAct_9fa48("386") ? [] : (stryCov_9fa48("386"), [stryMutAct_9fa48("387") ? "" : (stryCov_9fa48("387"), "domain"), stryMutAct_9fa48("388") ? "" : (stryCov_9fa48("388"), "facet"), stryMutAct_9fa48("389") ? "" : (stryCov_9fa48("389"), "generation"), stryMutAct_9fa48("390") ? "" : (stryCov_9fa48("390"), "grantId"), stryMutAct_9fa48("391") ? "" : (stryCov_9fa48("391"), "name"), stryMutAct_9fa48("392") ? "" : (stryCov_9fa48("392"), "revision"), stryMutAct_9fa48("393") ? "" : (stryCov_9fa48("393"), "scope"), stryMutAct_9fa48("394") ? "" : (stryCov_9fa48("394"), "state"), stryMutAct_9fa48("395") ? "" : (stryCov_9fa48("395"), "subject")]), stryMutAct_9fa48("396") ? "" : (stryCov_9fa48("396"), "Binding"));
      return new Binding(decodeAuthorityScope(object[stryMutAct_9fa48("397") ? "" : (stryCov_9fa48("397"), "scope")]!), decodeAuthoritySubject(object[stryMutAct_9fa48("398") ? "" : (stryCov_9fa48("398"), "subject")]!), decodeDomain(object[stryMutAct_9fa48("399") ? "" : (stryCov_9fa48("399"), "domain")]), new BindingName(requireString(object, stryMutAct_9fa48("400") ? "" : (stryCov_9fa48("400"), "name"), stryMutAct_9fa48("401") ? "" : (stryCov_9fa48("401"), "Binding name"))), new GrantId(requireString(object, stryMutAct_9fa48("402") ? "" : (stryCov_9fa48("402"), "grantId"), stryMutAct_9fa48("403") ? "" : (stryCov_9fa48("403"), "Grant ID"))), new FacetRef(requireString(object, stryMutAct_9fa48("404") ? "" : (stryCov_9fa48("404"), "facet"), stryMutAct_9fa48("405") ? "" : (stryCov_9fa48("405"), "Facet reference"))), requireSafeInteger(object, stryMutAct_9fa48("406") ? "" : (stryCov_9fa48("406"), "generation"), stryMutAct_9fa48("407") ? "" : (stryCov_9fa48("407"), "Binding generation")), requireBindingState(object[stryMutAct_9fa48("408") ? "" : (stryCov_9fa48("408"), "state")]), new Revision(requireSafeInteger(object, stryMutAct_9fa48("409") ? "" : (stryCov_9fa48("409"), "revision"), stryMutAct_9fa48("410") ? "" : (stryCov_9fa48("410"), "Binding revision"))));
    }
  }
  private transition(state: BindingLifecycle, grantId: GrantId, facet: FacetRef): Binding {
    if (stryMutAct_9fa48("411")) {
      {}
    } else {
      stryCov_9fa48("411");
      if (stryMutAct_9fa48("414") ? this.generation === Number.MAX_SAFE_INTEGER && this.revision.value === Number.MAX_SAFE_INTEGER : stryMutAct_9fa48("413") ? false : stryMutAct_9fa48("412") ? true : (stryCov_9fa48("412", "413", "414"), (stryMutAct_9fa48("416") ? this.generation !== Number.MAX_SAFE_INTEGER : stryMutAct_9fa48("415") ? false : (stryCov_9fa48("415", "416"), this.generation === Number.MAX_SAFE_INTEGER)) || (stryMutAct_9fa48("418") ? this.revision.value !== Number.MAX_SAFE_INTEGER : stryMutAct_9fa48("417") ? false : (stryCov_9fa48("417", "418"), this.revision.value === Number.MAX_SAFE_INTEGER)))) {
        if (stryMutAct_9fa48("419")) {
          {}
        } else {
          stryCov_9fa48("419");
          throw new AgentCoreError(stryMutAct_9fa48("420") ? "" : (stryCov_9fa48("420"), "binding.invalid"), stryMutAct_9fa48("421") ? "" : (stryCov_9fa48("421"), "Binding generation is exhausted"));
        }
      }
      return new Binding(this.scope, this.subject, this.domain, this.name, grantId, facet, stryMutAct_9fa48("422") ? this.generation - 1 : (stryCov_9fa48("422"), this.generation + 1), state.name, this.revision.next());
    }
  }
}
export function encodeDomain(domain: ProtectionDomain): JsonObject {
  if (stryMutAct_9fa48("423")) {
    {}
  } else {
    stryCov_9fa48("423");
    return stryMutAct_9fa48("424") ? {} : (stryCov_9fa48("424"), {
      kind: domain.kind,
      label: domain.label,
      secretPolicy: domain.secretPolicy
    });
  }
}
export function domainKey(domain: ProtectionDomain): string {
  if (stryMutAct_9fa48("425")) {
    {}
  } else {
    stryCov_9fa48("425");
    return authorityKey(stryMutAct_9fa48("426") ? "" : (stryCov_9fa48("426"), "domain"), stryMutAct_9fa48("427") ? [] : (stryCov_9fa48("427"), [encodeDomain(domain)]));
  }
}
function immutableDomain(domain: ProtectionDomain): ProtectionDomain {
  if (stryMutAct_9fa48("428")) {
    {}
  } else {
    stryCov_9fa48("428");
    return Object.freeze(new ProtectionDomain(domain.kind, domain.label, domain.secretPolicy));
  }
}
export function decodeDomain(value: JsonValue | undefined): ProtectionDomain {
  if (stryMutAct_9fa48("429")) {
    {}
  } else {
    stryCov_9fa48("429");
    const object = requireObject(value, stryMutAct_9fa48("430") ? "" : (stryCov_9fa48("430"), "Protection domain"));
    requireExact(object, stryMutAct_9fa48("431") ? [] : (stryCov_9fa48("431"), [stryMutAct_9fa48("432") ? "" : (stryCov_9fa48("432"), "kind"), stryMutAct_9fa48("433") ? "" : (stryCov_9fa48("433"), "label"), stryMutAct_9fa48("434") ? "" : (stryCov_9fa48("434"), "secretPolicy")]), stryMutAct_9fa48("435") ? "" : (stryCov_9fa48("435"), "Protection domain"));
    const kind = object[stryMutAct_9fa48("436") ? "" : (stryCov_9fa48("436"), "kind")];
    const secretPolicy = object[stryMutAct_9fa48("437") ? "" : (stryCov_9fa48("437"), "secretPolicy")];
    if (stryMutAct_9fa48("440") ? kind !== "frontend" || kind !== "backend" : stryMutAct_9fa48("439") ? false : stryMutAct_9fa48("438") ? true : (stryCov_9fa48("438", "439", "440"), (stryMutAct_9fa48("442") ? kind === "frontend" : stryMutAct_9fa48("441") ? true : (stryCov_9fa48("441", "442"), kind !== (stryMutAct_9fa48("443") ? "" : (stryCov_9fa48("443"), "frontend")))) && (stryMutAct_9fa48("445") ? kind === "backend" : stryMutAct_9fa48("444") ? true : (stryCov_9fa48("444", "445"), kind !== (stryMutAct_9fa48("446") ? "" : (stryCov_9fa48("446"), "backend")))))) {
      if (stryMutAct_9fa48("447")) {
        {}
      } else {
        stryCov_9fa48("447");
        throw new TypeError(stryMutAct_9fa48("448") ? "" : (stryCov_9fa48("448"), "Protection domain kind is invalid"));
      }
    }
    if (stryMutAct_9fa48("451") ? secretPolicy !== "no-secrets" || secretPolicy !== "may-hold-secrets" : stryMutAct_9fa48("450") ? false : stryMutAct_9fa48("449") ? true : (stryCov_9fa48("449", "450", "451"), (stryMutAct_9fa48("453") ? secretPolicy === "no-secrets" : stryMutAct_9fa48("452") ? true : (stryCov_9fa48("452", "453"), secretPolicy !== (stryMutAct_9fa48("454") ? "" : (stryCov_9fa48("454"), "no-secrets")))) && (stryMutAct_9fa48("456") ? secretPolicy === "may-hold-secrets" : stryMutAct_9fa48("455") ? true : (stryCov_9fa48("455", "456"), secretPolicy !== (stryMutAct_9fa48("457") ? "" : (stryCov_9fa48("457"), "may-hold-secrets")))))) {
      if (stryMutAct_9fa48("458")) {
        {}
      } else {
        stryCov_9fa48("458");
        throw new TypeError(stryMutAct_9fa48("459") ? "" : (stryCov_9fa48("459"), "Protection domain secret policy is invalid"));
      }
    }
    return new ProtectionDomain(kind, requireString(object, stryMutAct_9fa48("460") ? "" : (stryCov_9fa48("460"), "label"), stryMutAct_9fa48("461") ? "" : (stryCov_9fa48("461"), "Protection domain label")), secretPolicy);
  }
}
function requireBindingState(value: JsonValue | undefined): BindingStateName {
  if (stryMutAct_9fa48("462")) {
    {}
  } else {
    stryCov_9fa48("462");
    if (stryMutAct_9fa48("465") ? value === "active" && value === "inactive" : stryMutAct_9fa48("464") ? false : stryMutAct_9fa48("463") ? true : (stryCov_9fa48("463", "464", "465"), (stryMutAct_9fa48("467") ? value !== "active" : stryMutAct_9fa48("466") ? false : (stryCov_9fa48("466", "467"), value === (stryMutAct_9fa48("468") ? "" : (stryCov_9fa48("468"), "active")))) || (stryMutAct_9fa48("470") ? value !== "inactive" : stryMutAct_9fa48("469") ? false : (stryCov_9fa48("469", "470"), value === (stryMutAct_9fa48("471") ? "" : (stryCov_9fa48("471"), "inactive")))))) return value;
    throw new TypeError(stryMutAct_9fa48("472") ? "" : (stryCov_9fa48("472"), "Binding state is invalid"));
  }
}