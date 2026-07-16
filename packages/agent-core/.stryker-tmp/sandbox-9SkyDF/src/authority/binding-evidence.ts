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
import { Digest, RecordCodec, encodeCanonicalJson, type JsonValue } from "../core";
import { BindingName, FacetRef, ProtectionDomain } from "../facets";
import { TenantId, type ScopeRef, type SubjectRef } from "../identity";
import { decodeDomain, encodeDomain } from "./binding";
import { requireExact, requireObject, requireSafeInteger, requireString, type JsonObject } from "./data";
import { PathEpochEvidence } from "./epoch";
import { GrantId } from "./id";
import { decodeAuthorityScope, decodeAuthoritySubject, encodeAuthorityScope, encodeAuthoritySubject } from "./reference";
export interface BindingValidationRequestInit {
  readonly ownerTenant: TenantId;
  readonly workspaceActor: ActorRef;
  readonly workspaceFence: number;
  readonly scope: ScopeRef;
  readonly domain: ProtectionDomain;
  readonly name: BindingName;
  readonly grantId: GrantId;
  readonly facet: FacetRef;
  readonly nonce: string;
}
class BindingValidationRequestCodec extends RecordCodec<BindingValidationRequest> {
  public constructor() {
    if (stryMutAct_9fa48("0")) {
      {}
    } else {
      stryCov_9fa48("0");
      super(stryMutAct_9fa48("1") ? "" : (stryCov_9fa48("1"), "authority.binding-validation-request"), stryMutAct_9fa48("2") ? {} : (stryCov_9fa48("2"), {
        major: 1,
        minor: 0
      }));
    }
  }
  protected encodePayload(record: BindingValidationRequest): JsonValue {
    if (stryMutAct_9fa48("3")) {
      {}
    } else {
      stryCov_9fa48("3");
      return record.toData();
    }
  }
  protected decodePayload(payload: JsonValue): BindingValidationRequest {
    if (stryMutAct_9fa48("4")) {
      {}
    } else {
      stryCov_9fa48("4");
      return BindingValidationRequest.fromData(payload);
    }
  }
}
export class BindingValidationRequest {
  public static readonly codec: RecordCodec<BindingValidationRequest> = new BindingValidationRequestCodec();
  public readonly domain: ProtectionDomain;
  public constructor(init: BindingValidationRequestInit) {
    if (stryMutAct_9fa48("5")) {
      {}
    } else {
      stryCov_9fa48("5");
      if (stryMutAct_9fa48("8") ? init.workspaceActor.kind !== "workspace" && init.scope.kind !== "workspace" : stryMutAct_9fa48("7") ? false : stryMutAct_9fa48("6") ? true : (stryCov_9fa48("6", "7", "8"), (stryMutAct_9fa48("10") ? init.workspaceActor.kind === "workspace" : stryMutAct_9fa48("9") ? false : (stryCov_9fa48("9", "10"), init.workspaceActor.kind !== (stryMutAct_9fa48("11") ? "" : (stryCov_9fa48("11"), "workspace")))) || (stryMutAct_9fa48("13") ? init.scope.kind === "workspace" : stryMutAct_9fa48("12") ? false : (stryCov_9fa48("12", "13"), init.scope.kind !== (stryMutAct_9fa48("14") ? "" : (stryCov_9fa48("14"), "workspace")))))) {
        if (stryMutAct_9fa48("15")) {
          {}
        } else {
          stryCov_9fa48("15");
          throw new TypeError(stryMutAct_9fa48("16") ? "" : (stryCov_9fa48("16"), "Binding validation requires a Workspace Actor and Scope"));
        }
      }
      if (stryMutAct_9fa48("19") ? !Number.isSafeInteger(init.workspaceFence) && init.workspaceFence < 0 : stryMutAct_9fa48("18") ? false : stryMutAct_9fa48("17") ? true : (stryCov_9fa48("17", "18", "19"), (stryMutAct_9fa48("20") ? Number.isSafeInteger(init.workspaceFence) : (stryCov_9fa48("20"), !Number.isSafeInteger(init.workspaceFence))) || (stryMutAct_9fa48("23") ? init.workspaceFence >= 0 : stryMutAct_9fa48("22") ? init.workspaceFence <= 0 : stryMutAct_9fa48("21") ? false : (stryCov_9fa48("21", "22", "23"), init.workspaceFence < 0)))) {
        if (stryMutAct_9fa48("24")) {
          {}
        } else {
          stryCov_9fa48("24");
          throw new TypeError(stryMutAct_9fa48("25") ? "" : (stryCov_9fa48("25"), "Binding validation fence is invalid"));
        }
      }
      if (stryMutAct_9fa48("28") ? init.nonce.length === 0 && init.nonce !== init.nonce.trim() : stryMutAct_9fa48("27") ? false : stryMutAct_9fa48("26") ? true : (stryCov_9fa48("26", "27", "28"), (stryMutAct_9fa48("30") ? init.nonce.length !== 0 : stryMutAct_9fa48("29") ? false : (stryCov_9fa48("29", "30"), init.nonce.length === 0)) || (stryMutAct_9fa48("32") ? init.nonce === init.nonce.trim() : stryMutAct_9fa48("31") ? false : (stryCov_9fa48("31", "32"), init.nonce !== (stryMutAct_9fa48("33") ? init.nonce : (stryCov_9fa48("33"), init.nonce.trim())))))) {
        if (stryMutAct_9fa48("34")) {
          {}
        } else {
          stryCov_9fa48("34");
          throw new TypeError(stryMutAct_9fa48("35") ? "" : (stryCov_9fa48("35"), "Binding validation nonce must be canonical and nonblank"));
        }
      }
      this.ownerTenant = init.ownerTenant;
      this.workspaceActor = init.workspaceActor;
      this.workspaceFence = init.workspaceFence;
      this.scope = init.scope;
      this.domain = Object.freeze(new ProtectionDomain(init.domain.kind, init.domain.label, init.domain.secretPolicy));
      this.name = init.name;
      this.grantId = init.grantId;
      this.facet = init.facet;
      this.nonce = init.nonce;
      Object.freeze(this);
    }
  }
  public readonly ownerTenant: TenantId;
  public readonly workspaceActor: ActorRef;
  public readonly workspaceFence: number;
  public readonly scope: ScopeRef;
  public readonly name: BindingName;
  public readonly grantId: GrantId;
  public readonly facet: FacetRef;
  public readonly nonce: string;
  public digest(): Digest {
    if (stryMutAct_9fa48("36")) {
      {}
    } else {
      stryCov_9fa48("36");
      return Digest.sha256(encodeCanonicalJson(this.toData()));
    }
  }
  public static encode(record: BindingValidationRequest): Uint8Array {
    if (stryMutAct_9fa48("37")) {
      {}
    } else {
      stryCov_9fa48("37");
      return BindingValidationRequest.codec.encode(record);
    }
  }
  public static decode(bytes: Uint8Array): BindingValidationRequest {
    if (stryMutAct_9fa48("38")) {
      {}
    } else {
      stryCov_9fa48("38");
      return BindingValidationRequest.codec.decode(bytes);
    }
  }
  public toData(): JsonObject {
    if (stryMutAct_9fa48("39")) {
      {}
    } else {
      stryCov_9fa48("39");
      return stryMutAct_9fa48("40") ? {} : (stryCov_9fa48("40"), {
        domain: encodeDomain(this.domain),
        facet: this.facet.value,
        grantId: this.grantId.value,
        name: this.name.value,
        nonce: this.nonce,
        ownerTenant: this.ownerTenant.value,
        scope: encodeAuthorityScope(this.scope),
        workspaceActor: stryMutAct_9fa48("41") ? {} : (stryCov_9fa48("41"), {
          id: this.workspaceActor.id.value,
          kind: this.workspaceActor.kind
        }),
        workspaceFence: this.workspaceFence
      });
    }
  }
  public static fromData(value: JsonValue | undefined): BindingValidationRequest {
    if (stryMutAct_9fa48("42")) {
      {}
    } else {
      stryCov_9fa48("42");
      const object = requireObject(value, stryMutAct_9fa48("43") ? "" : (stryCov_9fa48("43"), "Binding validation request"));
      requireExact(object, stryMutAct_9fa48("44") ? [] : (stryCov_9fa48("44"), [stryMutAct_9fa48("45") ? "" : (stryCov_9fa48("45"), "domain"), stryMutAct_9fa48("46") ? "" : (stryCov_9fa48("46"), "facet"), stryMutAct_9fa48("47") ? "" : (stryCov_9fa48("47"), "grantId"), stryMutAct_9fa48("48") ? "" : (stryCov_9fa48("48"), "name"), stryMutAct_9fa48("49") ? "" : (stryCov_9fa48("49"), "nonce"), stryMutAct_9fa48("50") ? "" : (stryCov_9fa48("50"), "ownerTenant"), stryMutAct_9fa48("51") ? "" : (stryCov_9fa48("51"), "scope"), stryMutAct_9fa48("52") ? "" : (stryCov_9fa48("52"), "workspaceActor"), stryMutAct_9fa48("53") ? "" : (stryCov_9fa48("53"), "workspaceFence")]), stryMutAct_9fa48("54") ? "" : (stryCov_9fa48("54"), "Binding validation request"));
      const workspaceActor = requireObject(object[stryMutAct_9fa48("55") ? "" : (stryCov_9fa48("55"), "workspaceActor")], stryMutAct_9fa48("56") ? "" : (stryCov_9fa48("56"), "Binding Workspace Actor"));
      requireExact(workspaceActor, stryMutAct_9fa48("57") ? [] : (stryCov_9fa48("57"), [stryMutAct_9fa48("58") ? "" : (stryCov_9fa48("58"), "id"), stryMutAct_9fa48("59") ? "" : (stryCov_9fa48("59"), "kind")]), stryMutAct_9fa48("60") ? "" : (stryCov_9fa48("60"), "Binding Workspace Actor"));
      return new BindingValidationRequest(stryMutAct_9fa48("61") ? {} : (stryCov_9fa48("61"), {
        ownerTenant: new TenantId(requireString(object, stryMutAct_9fa48("62") ? "" : (stryCov_9fa48("62"), "ownerTenant"))),
        workspaceActor: new ActorRef(requireActorKind(workspaceActor[stryMutAct_9fa48("63") ? "" : (stryCov_9fa48("63"), "kind")]), new ActorId(requireString(workspaceActor, stryMutAct_9fa48("64") ? "" : (stryCov_9fa48("64"), "id")))),
        workspaceFence: requireSafeInteger(object, stryMutAct_9fa48("65") ? "" : (stryCov_9fa48("65"), "workspaceFence")),
        scope: decodeAuthorityScope(object[stryMutAct_9fa48("66") ? "" : (stryCov_9fa48("66"), "scope")]!),
        domain: decodeDomain(object[stryMutAct_9fa48("67") ? "" : (stryCov_9fa48("67"), "domain")]),
        name: new BindingName(requireString(object, stryMutAct_9fa48("68") ? "" : (stryCov_9fa48("68"), "name"))),
        grantId: new GrantId(requireString(object, stryMutAct_9fa48("69") ? "" : (stryCov_9fa48("69"), "grantId"))),
        facet: new FacetRef(requireString(object, stryMutAct_9fa48("70") ? "" : (stryCov_9fa48("70"), "facet"))),
        nonce: requireString(object, stryMutAct_9fa48("71") ? "" : (stryCov_9fa48("71"), "nonce"))
      }));
    }
  }
}
class BindingValidationEvidenceCodec extends RecordCodec<BindingValidationEvidence> {
  public constructor() {
    if (stryMutAct_9fa48("72")) {
      {}
    } else {
      stryCov_9fa48("72");
      super(stryMutAct_9fa48("73") ? "" : (stryCov_9fa48("73"), "authority.binding-validation-evidence"), stryMutAct_9fa48("74") ? {} : (stryCov_9fa48("74"), {
        major: 1,
        minor: 0
      }));
    }
  }
  protected encodePayload(record: BindingValidationEvidence): JsonValue {
    if (stryMutAct_9fa48("75")) {
      {}
    } else {
      stryCov_9fa48("75");
      return record.toData();
    }
  }
  protected decodePayload(payload: JsonValue): BindingValidationEvidence {
    if (stryMutAct_9fa48("76")) {
      {}
    } else {
      stryCov_9fa48("76");
      return BindingValidationEvidence.fromData(payload);
    }
  }
}
export class BindingValidationEvidence {
  public static readonly codec: RecordCodec<BindingValidationEvidence> = new BindingValidationEvidenceCodec();
  readonly #checkedAt: number;
  public readonly subject: SubjectRef;
  public constructor(public readonly issuerTenant: TenantId, public readonly issuer: ActorRef, public readonly requestDigest: Digest, public readonly scope: ScopeRef, subject: SubjectRef, public readonly grantId: GrantId, public readonly pathEpochs: PathEpochEvidence, checkedAt: Date) {
    if (stryMutAct_9fa48("77")) {
      {}
    } else {
      stryCov_9fa48("77");
      const time = checkedAt.getTime();
      if (stryMutAct_9fa48("80") ? !Number.isSafeInteger(time) && time < 0 : stryMutAct_9fa48("79") ? false : stryMutAct_9fa48("78") ? true : (stryCov_9fa48("78", "79", "80"), (stryMutAct_9fa48("81") ? Number.isSafeInteger(time) : (stryCov_9fa48("81"), !Number.isSafeInteger(time))) || (stryMutAct_9fa48("84") ? time >= 0 : stryMutAct_9fa48("83") ? time <= 0 : stryMutAct_9fa48("82") ? false : (stryCov_9fa48("82", "83", "84"), time < 0)))) {
        if (stryMutAct_9fa48("85")) {
          {}
        } else {
          stryCov_9fa48("85");
          throw new TypeError(stryMutAct_9fa48("86") ? "" : (stryCov_9fa48("86"), "Binding validation time is invalid"));
        }
      }
      if (stryMutAct_9fa48("89") ? scope.kind !== "workspace" && !scope.equals(pathEpochs.target.scope) : stryMutAct_9fa48("88") ? false : stryMutAct_9fa48("87") ? true : (stryCov_9fa48("87", "88", "89"), (stryMutAct_9fa48("91") ? scope.kind === "workspace" : stryMutAct_9fa48("90") ? false : (stryCov_9fa48("90", "91"), scope.kind !== (stryMutAct_9fa48("92") ? "" : (stryCov_9fa48("92"), "workspace")))) || (stryMutAct_9fa48("93") ? scope.equals(pathEpochs.target.scope) : (stryCov_9fa48("93"), !scope.equals(pathEpochs.target.scope))))) {
        if (stryMutAct_9fa48("94")) {
          {}
        } else {
          stryCov_9fa48("94");
          throw new TypeError(stryMutAct_9fa48("95") ? "" : (stryCov_9fa48("95"), "Binding validation path must end at its Workspace Scope"));
        }
      }
      if (stryMutAct_9fa48("98") ? issuer.kind === "tenant" : stryMutAct_9fa48("97") ? false : stryMutAct_9fa48("96") ? true : (stryCov_9fa48("96", "97", "98"), issuer.kind !== (stryMutAct_9fa48("99") ? "" : (stryCov_9fa48("99"), "tenant")))) {
        if (stryMutAct_9fa48("100")) {
          {}
        } else {
          stryCov_9fa48("100");
          throw new TypeError(stryMutAct_9fa48("101") ? "" : (stryCov_9fa48("101"), "Binding validation evidence must be issued by a Tenant Actor"));
        }
      }
      if (stryMutAct_9fa48("104") ? false : stryMutAct_9fa48("103") ? true : stryMutAct_9fa48("102") ? issuerTenant.equals(scope.tenantId) : (stryCov_9fa48("102", "103", "104"), !issuerTenant.equals(scope.tenantId))) {
        if (stryMutAct_9fa48("105")) {
          {}
        } else {
          stryCov_9fa48("105");
          throw new TypeError(stryMutAct_9fa48("106") ? "" : (stryCov_9fa48("106"), "Binding validation issuer Tenant must match its Scope"));
        }
      }
      this.subject = decodeAuthoritySubject(encodeAuthoritySubject(subject));
      this.#checkedAt = time;
      Object.freeze(this);
    }
  }
  public static encode(record: BindingValidationEvidence): Uint8Array {
    if (stryMutAct_9fa48("107")) {
      {}
    } else {
      stryCov_9fa48("107");
      return BindingValidationEvidence.codec.encode(record);
    }
  }
  public static decode(bytes: Uint8Array): BindingValidationEvidence {
    if (stryMutAct_9fa48("108")) {
      {}
    } else {
      stryCov_9fa48("108");
      return BindingValidationEvidence.codec.decode(bytes);
    }
  }
  public get checkedAt(): Date {
    if (stryMutAct_9fa48("109")) {
      {}
    } else {
      stryCov_9fa48("109");
      return new Date(this.#checkedAt);
    }
  }
  public binds(request: BindingValidationRequest): boolean {
    if (stryMutAct_9fa48("110")) {
      {}
    } else {
      stryCov_9fa48("110");
      return stryMutAct_9fa48("113") ? this.requestDigest.equals(request.digest()) && this.issuerTenant.equals(request.ownerTenant) && this.scope.equals(request.scope) || this.grantId.equals(request.grantId) : stryMutAct_9fa48("112") ? false : stryMutAct_9fa48("111") ? true : (stryCov_9fa48("111", "112", "113"), (stryMutAct_9fa48("115") ? this.requestDigest.equals(request.digest()) && this.issuerTenant.equals(request.ownerTenant) || this.scope.equals(request.scope) : stryMutAct_9fa48("114") ? true : (stryCov_9fa48("114", "115"), (stryMutAct_9fa48("117") ? this.requestDigest.equals(request.digest()) || this.issuerTenant.equals(request.ownerTenant) : stryMutAct_9fa48("116") ? true : (stryCov_9fa48("116", "117"), this.requestDigest.equals(request.digest()) && this.issuerTenant.equals(request.ownerTenant))) && this.scope.equals(request.scope))) && this.grantId.equals(request.grantId));
    }
  }
  public toData(): JsonObject {
    if (stryMutAct_9fa48("118")) {
      {}
    } else {
      stryCov_9fa48("118");
      return stryMutAct_9fa48("119") ? {} : (stryCov_9fa48("119"), {
        checkedAt: this.#checkedAt,
        grantId: this.grantId.value,
        issuer: stryMutAct_9fa48("120") ? {} : (stryCov_9fa48("120"), {
          id: this.issuer.id.value,
          kind: this.issuer.kind
        }),
        issuerTenant: this.issuerTenant.value,
        pathEpochs: this.pathEpochs.toData(),
        requestDigest: this.requestDigest.value,
        scope: encodeAuthorityScope(this.scope),
        subject: encodeAuthoritySubject(this.subject)
      });
    }
  }
  public static fromData(value: JsonValue | undefined): BindingValidationEvidence {
    if (stryMutAct_9fa48("121")) {
      {}
    } else {
      stryCov_9fa48("121");
      const object = requireObject(value, stryMutAct_9fa48("122") ? "" : (stryCov_9fa48("122"), "Binding validation evidence"));
      requireExact(object, stryMutAct_9fa48("123") ? [] : (stryCov_9fa48("123"), [stryMutAct_9fa48("124") ? "" : (stryCov_9fa48("124"), "checkedAt"), stryMutAct_9fa48("125") ? "" : (stryCov_9fa48("125"), "grantId"), stryMutAct_9fa48("126") ? "" : (stryCov_9fa48("126"), "issuer"), stryMutAct_9fa48("127") ? "" : (stryCov_9fa48("127"), "issuerTenant"), stryMutAct_9fa48("128") ? "" : (stryCov_9fa48("128"), "pathEpochs"), stryMutAct_9fa48("129") ? "" : (stryCov_9fa48("129"), "requestDigest"), stryMutAct_9fa48("130") ? "" : (stryCov_9fa48("130"), "scope"), stryMutAct_9fa48("131") ? "" : (stryCov_9fa48("131"), "subject")]), stryMutAct_9fa48("132") ? "" : (stryCov_9fa48("132"), "Binding validation evidence"));
      const issuer = requireObject(object[stryMutAct_9fa48("133") ? "" : (stryCov_9fa48("133"), "issuer")], stryMutAct_9fa48("134") ? "" : (stryCov_9fa48("134"), "Binding validation issuer"));
      requireExact(issuer, stryMutAct_9fa48("135") ? [] : (stryCov_9fa48("135"), [stryMutAct_9fa48("136") ? "" : (stryCov_9fa48("136"), "id"), stryMutAct_9fa48("137") ? "" : (stryCov_9fa48("137"), "kind")]), stryMutAct_9fa48("138") ? "" : (stryCov_9fa48("138"), "Binding validation issuer"));
      return new BindingValidationEvidence(new TenantId(requireString(object, stryMutAct_9fa48("139") ? "" : (stryCov_9fa48("139"), "issuerTenant"))), new ActorRef(requireActorKind(issuer[stryMutAct_9fa48("140") ? "" : (stryCov_9fa48("140"), "kind")]), new ActorId(requireString(issuer, stryMutAct_9fa48("141") ? "" : (stryCov_9fa48("141"), "id")))), new Digest(requireString(object, stryMutAct_9fa48("142") ? "" : (stryCov_9fa48("142"), "requestDigest"))), decodeAuthorityScope(object[stryMutAct_9fa48("143") ? "" : (stryCov_9fa48("143"), "scope")]!), decodeAuthoritySubject(object[stryMutAct_9fa48("144") ? "" : (stryCov_9fa48("144"), "subject")]!), new GrantId(requireString(object, stryMutAct_9fa48("145") ? "" : (stryCov_9fa48("145"), "grantId"))), PathEpochEvidence.fromData(object[stryMutAct_9fa48("146") ? "" : (stryCov_9fa48("146"), "pathEpochs")]), new Date(requireSafeInteger(object, stryMutAct_9fa48("147") ? "" : (stryCov_9fa48("147"), "checkedAt"))));
    }
  }
}
function requireActorKind(value: JsonValue | undefined): ActorKind {
  if (stryMutAct_9fa48("148")) {
    {}
  } else {
    stryCov_9fa48("148");
    if (stryMutAct_9fa48("151") ? (value === "tenant" || value === "workspace" || value === "run" || value === "environment") && value === "slate" : stryMutAct_9fa48("150") ? false : stryMutAct_9fa48("149") ? true : (stryCov_9fa48("149", "150", "151"), (stryMutAct_9fa48("153") ? (value === "tenant" || value === "workspace" || value === "run") && value === "environment" : stryMutAct_9fa48("152") ? false : (stryCov_9fa48("152", "153"), (stryMutAct_9fa48("155") ? (value === "tenant" || value === "workspace") && value === "run" : stryMutAct_9fa48("154") ? false : (stryCov_9fa48("154", "155"), (stryMutAct_9fa48("157") ? value === "tenant" && value === "workspace" : stryMutAct_9fa48("156") ? false : (stryCov_9fa48("156", "157"), (stryMutAct_9fa48("159") ? value !== "tenant" : stryMutAct_9fa48("158") ? false : (stryCov_9fa48("158", "159"), value === (stryMutAct_9fa48("160") ? "" : (stryCov_9fa48("160"), "tenant")))) || (stryMutAct_9fa48("162") ? value !== "workspace" : stryMutAct_9fa48("161") ? false : (stryCov_9fa48("161", "162"), value === (stryMutAct_9fa48("163") ? "" : (stryCov_9fa48("163"), "workspace")))))) || (stryMutAct_9fa48("165") ? value !== "run" : stryMutAct_9fa48("164") ? false : (stryCov_9fa48("164", "165"), value === (stryMutAct_9fa48("166") ? "" : (stryCov_9fa48("166"), "run")))))) || (stryMutAct_9fa48("168") ? value !== "environment" : stryMutAct_9fa48("167") ? false : (stryCov_9fa48("167", "168"), value === (stryMutAct_9fa48("169") ? "" : (stryCov_9fa48("169"), "environment")))))) || (stryMutAct_9fa48("171") ? value !== "slate" : stryMutAct_9fa48("170") ? false : (stryCov_9fa48("170", "171"), value === (stryMutAct_9fa48("172") ? "" : (stryCov_9fa48("172"), "slate")))))) return value;
    throw new TypeError(stryMutAct_9fa48("173") ? "" : (stryCov_9fa48("173"), "Binding validation Actor kind is invalid"));
  }
}