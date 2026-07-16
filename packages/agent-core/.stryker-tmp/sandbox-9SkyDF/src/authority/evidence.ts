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
import { FacetRef, type Impact } from "../facets";
import { PrincipalId, PrincipalRef, TenantId } from "../identity";
import { Binding } from "./binding";
import { requireArray, canonicalJson, requireExact, requireObject, requireSafeInteger, requireString, type JsonObject } from "./data";
import { PathEpochEvidence } from "./epoch";
import { GrantId } from "./id";
export type AuthorityDecisionReason = "allowed" | "missingPrincipal" | "inactivePrincipal" | "invalidBinding" | "missingGrant" | "revokedGrant" | "invalidDelegation" | "guestElevation" | "guestVerificationExpired" | "noMatchingAllow" | "matchingDeny" | "stalePath";
export interface AuthorityOperationIntent {
  readonly facet: FacetRef;
  readonly operation: string;
  readonly impact: Impact;
  readonly arguments: Readonly<Record<string, JsonValue>>;
  readonly argumentsDigest: Digest;
}
export interface AuthorityCheckRequestInit {
  readonly ownerTenant: TenantId;
  readonly owner: ActorRef;
  readonly ownerFence: number;
  readonly principal: PrincipalRef;
  readonly binding: Binding;
  readonly intent: AuthorityOperationIntent;
  readonly expectedPath: PathEpochEvidence;
  readonly invocationDigest: Digest;
  readonly itemIndex: number;
  readonly attemptOrdinal: number;
  readonly nonce: string;
}
class AuthorityCheckRequestCodec extends RecordCodec<AuthorityCheckRequest> {
  public constructor() {
    if (stryMutAct_9fa48("869")) {
      {}
    } else {
      stryCov_9fa48("869");
      super(stryMutAct_9fa48("870") ? "" : (stryCov_9fa48("870"), "authority.check-request"), stryMutAct_9fa48("871") ? {} : (stryCov_9fa48("871"), {
        major: 1,
        minor: 0
      }));
    }
  }
  protected encodePayload(record: AuthorityCheckRequest): JsonValue {
    if (stryMutAct_9fa48("872")) {
      {}
    } else {
      stryCov_9fa48("872");
      return record.toData();
    }
  }
  protected decodePayload(payload: JsonValue): AuthorityCheckRequest {
    if (stryMutAct_9fa48("873")) {
      {}
    } else {
      stryCov_9fa48("873");
      return AuthorityCheckRequest.fromData(payload);
    }
  }
}
export class AuthorityCheckRequest {
  public static readonly codec: RecordCodec<AuthorityCheckRequest> = new AuthorityCheckRequestCodec();
  public readonly intent: AuthorityOperationIntent;
  public constructor(init: AuthorityCheckRequestInit) {
    if (stryMutAct_9fa48("874")) {
      {}
    } else {
      stryCov_9fa48("874");
      requireSafeNonnegative(init.ownerFence, stryMutAct_9fa48("875") ? "" : (stryCov_9fa48("875"), "Authority owner fence"));
      requireSafeNonnegative(init.itemIndex, stryMutAct_9fa48("876") ? "" : (stryCov_9fa48("876"), "Authority item index"));
      requireSafeNonnegative(init.attemptOrdinal, stryMutAct_9fa48("877") ? "" : (stryCov_9fa48("877"), "Authority attempt ordinal"));
      if (stryMutAct_9fa48("880") ? init.nonce.length === 0 && init.nonce !== init.nonce.trim() : stryMutAct_9fa48("879") ? false : stryMutAct_9fa48("878") ? true : (stryCov_9fa48("878", "879", "880"), (stryMutAct_9fa48("882") ? init.nonce.length !== 0 : stryMutAct_9fa48("881") ? false : (stryCov_9fa48("881", "882"), init.nonce.length === 0)) || (stryMutAct_9fa48("884") ? init.nonce === init.nonce.trim() : stryMutAct_9fa48("883") ? false : (stryCov_9fa48("883", "884"), init.nonce !== (stryMutAct_9fa48("885") ? init.nonce : (stryCov_9fa48("885"), init.nonce.trim())))))) {
        if (stryMutAct_9fa48("886")) {
          {}
        } else {
          stryCov_9fa48("886");
          throw new TypeError(stryMutAct_9fa48("887") ? "" : (stryCov_9fa48("887"), "Authority check nonce must be canonical and nonblank"));
        }
      }
      if (stryMutAct_9fa48("890") ? init.intent.operation.length === 0 && init.intent.operation !== init.intent.operation.trim() : stryMutAct_9fa48("889") ? false : stryMutAct_9fa48("888") ? true : (stryCov_9fa48("888", "889", "890"), (stryMutAct_9fa48("892") ? init.intent.operation.length !== 0 : stryMutAct_9fa48("891") ? false : (stryCov_9fa48("891", "892"), init.intent.operation.length === 0)) || (stryMutAct_9fa48("894") ? init.intent.operation === init.intent.operation.trim() : stryMutAct_9fa48("893") ? false : (stryCov_9fa48("893", "894"), init.intent.operation !== (stryMutAct_9fa48("895") ? init.intent.operation : (stryCov_9fa48("895"), init.intent.operation.trim())))))) {
        if (stryMutAct_9fa48("896")) {
          {}
        } else {
          stryCov_9fa48("896");
          throw new TypeError(stryMutAct_9fa48("897") ? "" : (stryCov_9fa48("897"), "Authority operation must be canonical and nonblank"));
        }
      }
      this.ownerTenant = init.ownerTenant;
      this.owner = init.owner;
      this.ownerFence = init.ownerFence;
      this.principal = init.principal;
      this.binding = init.binding;
      const canonicalArguments = canonicalJson(init.intent.arguments);
      if (stryMutAct_9fa48("900") ? false : stryMutAct_9fa48("899") ? true : stryMutAct_9fa48("898") ? Digest.sha256(encodeCanonicalJson(canonicalArguments)).equals(init.intent.argumentsDigest) : (stryCov_9fa48("898", "899", "900"), !Digest.sha256(encodeCanonicalJson(canonicalArguments)).equals(init.intent.argumentsDigest))) {
        if (stryMutAct_9fa48("901")) {
          {}
        } else {
          stryCov_9fa48("901");
          throw new TypeError(stryMutAct_9fa48("902") ? "" : (stryCov_9fa48("902"), "Authority argument digest does not match canonical arguments"));
        }
      }
      this.intent = Object.freeze(stryMutAct_9fa48("903") ? {} : (stryCov_9fa48("903"), {
        ...init.intent,
        arguments: canonicalArguments
      }));
      this.expectedPath = init.expectedPath;
      this.invocationDigest = init.invocationDigest;
      this.itemIndex = init.itemIndex;
      this.attemptOrdinal = init.attemptOrdinal;
      this.nonce = init.nonce;
      Object.freeze(this);
    }
  }
  public readonly ownerTenant: TenantId;
  public readonly owner: ActorRef;
  public readonly ownerFence: number;
  public readonly principal: PrincipalRef;
  public readonly binding: Binding;
  public readonly invocationDigest: Digest;
  public readonly expectedPath: PathEpochEvidence;
  public readonly itemIndex: number;
  public readonly attemptOrdinal: number;
  public readonly nonce: string;
  public digest(): Digest {
    if (stryMutAct_9fa48("904")) {
      {}
    } else {
      stryCov_9fa48("904");
      return Digest.sha256(encodeCanonicalJson(this.toData()));
    }
  }
  public static encode(record: AuthorityCheckRequest): Uint8Array {
    if (stryMutAct_9fa48("905")) {
      {}
    } else {
      stryCov_9fa48("905");
      return AuthorityCheckRequest.codec.encode(record);
    }
  }
  public static decode(bytes: Uint8Array): AuthorityCheckRequest {
    if (stryMutAct_9fa48("906")) {
      {}
    } else {
      stryCov_9fa48("906");
      return AuthorityCheckRequest.codec.decode(bytes);
    }
  }
  public toData(): JsonObject {
    if (stryMutAct_9fa48("907")) {
      {}
    } else {
      stryCov_9fa48("907");
      return stryMutAct_9fa48("908") ? {} : (stryCov_9fa48("908"), {
        attemptOrdinal: this.attemptOrdinal,
        binding: this.binding.toData(),
        expectedPath: this.expectedPath.toData(),
        intent: encodeIntent(this.intent),
        invocationDigest: this.invocationDigest.value,
        itemIndex: this.itemIndex,
        nonce: this.nonce,
        owner: stryMutAct_9fa48("909") ? {} : (stryCov_9fa48("909"), {
          id: this.owner.id.value,
          kind: this.owner.kind
        }),
        ownerFence: this.ownerFence,
        ownerTenant: this.ownerTenant.value,
        principal: stryMutAct_9fa48("910") ? {} : (stryCov_9fa48("910"), {
          principal: this.principal.principalId.value,
          tenant: this.principal.tenantId.value
        })
      });
    }
  }
  public static fromData(value: JsonValue | undefined): AuthorityCheckRequest {
    if (stryMutAct_9fa48("911")) {
      {}
    } else {
      stryCov_9fa48("911");
      const object = requireObject(value, stryMutAct_9fa48("912") ? "" : (stryCov_9fa48("912"), "Authority check request"));
      requireExact(object, stryMutAct_9fa48("913") ? [] : (stryCov_9fa48("913"), [stryMutAct_9fa48("914") ? "" : (stryCov_9fa48("914"), "attemptOrdinal"), stryMutAct_9fa48("915") ? "" : (stryCov_9fa48("915"), "binding"), stryMutAct_9fa48("916") ? "" : (stryCov_9fa48("916"), "expectedPath"), stryMutAct_9fa48("917") ? "" : (stryCov_9fa48("917"), "intent"), stryMutAct_9fa48("918") ? "" : (stryCov_9fa48("918"), "invocationDigest"), stryMutAct_9fa48("919") ? "" : (stryCov_9fa48("919"), "itemIndex"), stryMutAct_9fa48("920") ? "" : (stryCov_9fa48("920"), "nonce"), stryMutAct_9fa48("921") ? "" : (stryCov_9fa48("921"), "owner"), stryMutAct_9fa48("922") ? "" : (stryCov_9fa48("922"), "ownerFence"), stryMutAct_9fa48("923") ? "" : (stryCov_9fa48("923"), "ownerTenant"), stryMutAct_9fa48("924") ? "" : (stryCov_9fa48("924"), "principal")]), stryMutAct_9fa48("925") ? "" : (stryCov_9fa48("925"), "Authority check request"));
      const owner = requireObject(object[stryMutAct_9fa48("926") ? "" : (stryCov_9fa48("926"), "owner")], stryMutAct_9fa48("927") ? "" : (stryCov_9fa48("927"), "Authority check owner"));
      const principal = requireObject(object[stryMutAct_9fa48("928") ? "" : (stryCov_9fa48("928"), "principal")], stryMutAct_9fa48("929") ? "" : (stryCov_9fa48("929"), "Authority check Principal"));
      requireExact(owner, stryMutAct_9fa48("930") ? [] : (stryCov_9fa48("930"), [stryMutAct_9fa48("931") ? "" : (stryCov_9fa48("931"), "id"), stryMutAct_9fa48("932") ? "" : (stryCov_9fa48("932"), "kind")]), stryMutAct_9fa48("933") ? "" : (stryCov_9fa48("933"), "Authority check owner"));
      requireExact(principal, stryMutAct_9fa48("934") ? [] : (stryCov_9fa48("934"), [stryMutAct_9fa48("935") ? "" : (stryCov_9fa48("935"), "principal"), stryMutAct_9fa48("936") ? "" : (stryCov_9fa48("936"), "tenant")]), stryMutAct_9fa48("937") ? "" : (stryCov_9fa48("937"), "Authority check Principal"));
      return new AuthorityCheckRequest(stryMutAct_9fa48("938") ? {} : (stryCov_9fa48("938"), {
        ownerTenant: new TenantId(requireString(object, stryMutAct_9fa48("939") ? "" : (stryCov_9fa48("939"), "ownerTenant"))),
        owner: new ActorRef(requireActorKind(owner[stryMutAct_9fa48("940") ? "" : (stryCov_9fa48("940"), "kind")]), new ActorId(requireString(owner, stryMutAct_9fa48("941") ? "" : (stryCov_9fa48("941"), "id")))),
        ownerFence: requireSafeInteger(object, stryMutAct_9fa48("942") ? "" : (stryCov_9fa48("942"), "ownerFence")),
        principal: new PrincipalRef(new TenantId(requireString(principal, stryMutAct_9fa48("943") ? "" : (stryCov_9fa48("943"), "tenant"))), new PrincipalId(requireString(principal, stryMutAct_9fa48("944") ? "" : (stryCov_9fa48("944"), "principal")))),
        binding: Binding.fromData(object[stryMutAct_9fa48("945") ? "" : (stryCov_9fa48("945"), "binding")]),
        intent: decodeIntent(object[stryMutAct_9fa48("946") ? "" : (stryCov_9fa48("946"), "intent")]),
        expectedPath: PathEpochEvidence.fromData(object[stryMutAct_9fa48("947") ? "" : (stryCov_9fa48("947"), "expectedPath")]),
        invocationDigest: new Digest(requireString(object, stryMutAct_9fa48("948") ? "" : (stryCov_9fa48("948"), "invocationDigest"))),
        itemIndex: requireSafeInteger(object, stryMutAct_9fa48("949") ? "" : (stryCov_9fa48("949"), "itemIndex")),
        attemptOrdinal: requireSafeInteger(object, stryMutAct_9fa48("950") ? "" : (stryCov_9fa48("950"), "attemptOrdinal")),
        nonce: requireString(object, stryMutAct_9fa48("951") ? "" : (stryCov_9fa48("951"), "nonce"))
      }));
    }
  }
}
class AuthorityCheckEvidenceCodec extends RecordCodec<AuthorityCheckEvidence> {
  public constructor() {
    if (stryMutAct_9fa48("952")) {
      {}
    } else {
      stryCov_9fa48("952");
      super(stryMutAct_9fa48("953") ? "" : (stryCov_9fa48("953"), "authority.check-evidence"), stryMutAct_9fa48("954") ? {} : (stryCov_9fa48("954"), {
        major: 1,
        minor: 0
      }));
    }
  }
  protected encodePayload(record: AuthorityCheckEvidence): JsonValue {
    if (stryMutAct_9fa48("955")) {
      {}
    } else {
      stryCov_9fa48("955");
      return record.toData();
    }
  }
  protected decodePayload(payload: JsonValue): AuthorityCheckEvidence {
    if (stryMutAct_9fa48("956")) {
      {}
    } else {
      stryCov_9fa48("956");
      return AuthorityCheckEvidence.fromData(payload);
    }
  }
}
export class AuthorityCheckEvidence {
  public static readonly codec: RecordCodec<AuthorityCheckEvidence> = new AuthorityCheckEvidenceCodec();
  readonly #checkedAt: number;
  public readonly matchedAllow: readonly GrantId[];
  public readonly matchedDeny: readonly GrantId[];
  public constructor(public readonly issuerTenant: TenantId, public readonly issuer: ActorRef, public readonly requestDigest: Digest, public readonly bindingKey: string, public readonly bindingGeneration: number, public readonly decision: "allow" | "deny", public readonly reason: AuthorityDecisionReason, matchedAllow: readonly GrantId[], matchedDeny: readonly GrantId[], public readonly pathEpochs: PathEpochEvidence, checkedAt: Date) {
    if (stryMutAct_9fa48("957")) {
      {}
    } else {
      stryCov_9fa48("957");
      requireSafeNonnegative(bindingGeneration, stryMutAct_9fa48("958") ? "" : (stryCov_9fa48("958"), "Authority Binding generation"));
      if (stryMutAct_9fa48("961") ? decision === "allow" === (reason === "allowed") : stryMutAct_9fa48("960") ? false : stryMutAct_9fa48("959") ? true : (stryCov_9fa48("959", "960", "961"), (stryMutAct_9fa48("964") ? decision !== "allow" : stryMutAct_9fa48("963") ? false : stryMutAct_9fa48("962") ? true : (stryCov_9fa48("962", "963", "964"), decision === (stryMutAct_9fa48("965") ? "" : (stryCov_9fa48("965"), "allow")))) !== (stryMutAct_9fa48("968") ? reason !== "allowed" : stryMutAct_9fa48("967") ? false : stryMutAct_9fa48("966") ? true : (stryCov_9fa48("966", "967", "968"), reason === (stryMutAct_9fa48("969") ? "" : (stryCov_9fa48("969"), "allowed")))))) {
        if (stryMutAct_9fa48("970")) {
          {}
        } else {
          stryCov_9fa48("970");
          throw new TypeError(stryMutAct_9fa48("971") ? "" : (stryCov_9fa48("971"), "Only allowed authority evidence may carry the allowed reason"));
        }
      }
      this.matchedAllow = canonicalGrantIds(matchedAllow);
      this.matchedDeny = canonicalGrantIds(matchedDeny);
      if (stryMutAct_9fa48("974") ? decision !== "allow" : stryMutAct_9fa48("973") ? false : stryMutAct_9fa48("972") ? true : (stryCov_9fa48("972", "973", "974"), decision === (stryMutAct_9fa48("975") ? "" : (stryCov_9fa48("975"), "allow")))) {
        if (stryMutAct_9fa48("976")) {
          {}
        } else {
          stryCov_9fa48("976");
          if (stryMutAct_9fa48("979") ? this.matchedAllow.length === 0 && this.matchedDeny.length > 0 : stryMutAct_9fa48("978") ? false : stryMutAct_9fa48("977") ? true : (stryCov_9fa48("977", "978", "979"), (stryMutAct_9fa48("981") ? this.matchedAllow.length !== 0 : stryMutAct_9fa48("980") ? false : (stryCov_9fa48("980", "981"), this.matchedAllow.length === 0)) || (stryMutAct_9fa48("984") ? this.matchedDeny.length <= 0 : stryMutAct_9fa48("983") ? this.matchedDeny.length >= 0 : stryMutAct_9fa48("982") ? false : (stryCov_9fa48("982", "983", "984"), this.matchedDeny.length > 0)))) {
            if (stryMutAct_9fa48("985")) {
              {}
            } else {
              stryCov_9fa48("985");
              throw new TypeError(stryMutAct_9fa48("986") ? "" : (stryCov_9fa48("986"), "Allowed authority evidence requires allow evidence and no deny evidence"));
            }
          }
        }
      } else if (stryMutAct_9fa48("989") ? reason !== "matchingDeny" : stryMutAct_9fa48("988") ? false : stryMutAct_9fa48("987") ? true : (stryCov_9fa48("987", "988", "989"), reason === (stryMutAct_9fa48("990") ? "" : (stryCov_9fa48("990"), "matchingDeny")))) {
        if (stryMutAct_9fa48("991")) {
          {}
        } else {
          stryCov_9fa48("991");
          if (stryMutAct_9fa48("994") ? this.matchedAllow.length > 0 && this.matchedDeny.length === 0 : stryMutAct_9fa48("993") ? false : stryMutAct_9fa48("992") ? true : (stryCov_9fa48("992", "993", "994"), (stryMutAct_9fa48("997") ? this.matchedAllow.length <= 0 : stryMutAct_9fa48("996") ? this.matchedAllow.length >= 0 : stryMutAct_9fa48("995") ? false : (stryCov_9fa48("995", "996", "997"), this.matchedAllow.length > 0)) || (stryMutAct_9fa48("999") ? this.matchedDeny.length !== 0 : stryMutAct_9fa48("998") ? false : (stryCov_9fa48("998", "999"), this.matchedDeny.length === 0)))) {
            if (stryMutAct_9fa48("1000")) {
              {}
            } else {
              stryCov_9fa48("1000");
              throw new TypeError(stryMutAct_9fa48("1001") ? "" : (stryCov_9fa48("1001"), "Matching-deny evidence requires only deny Grants"));
            }
          }
        }
      } else if (stryMutAct_9fa48("1004") ? this.matchedAllow.length > 0 && this.matchedDeny.length > 0 : stryMutAct_9fa48("1003") ? false : stryMutAct_9fa48("1002") ? true : (stryCov_9fa48("1002", "1003", "1004"), (stryMutAct_9fa48("1007") ? this.matchedAllow.length <= 0 : stryMutAct_9fa48("1006") ? this.matchedAllow.length >= 0 : stryMutAct_9fa48("1005") ? false : (stryCov_9fa48("1005", "1006", "1007"), this.matchedAllow.length > 0)) || (stryMutAct_9fa48("1010") ? this.matchedDeny.length <= 0 : stryMutAct_9fa48("1009") ? this.matchedDeny.length >= 0 : stryMutAct_9fa48("1008") ? false : (stryCov_9fa48("1008", "1009", "1010"), this.matchedDeny.length > 0)))) {
        if (stryMutAct_9fa48("1011")) {
          {}
        } else {
          stryCov_9fa48("1011");
          throw new TypeError(stryMutAct_9fa48("1012") ? "" : (stryCov_9fa48("1012"), "Non-matching authority denials cannot carry matched Grants"));
        }
      }
      if (stryMutAct_9fa48("1015") ? false : stryMutAct_9fa48("1014") ? true : stryMutAct_9fa48("1013") ? issuerTenant.equals(pathEpochs.target.scope.tenantId) : (stryCov_9fa48("1013", "1014", "1015"), !issuerTenant.equals(pathEpochs.target.scope.tenantId))) {
        if (stryMutAct_9fa48("1016")) {
          {}
        } else {
          stryCov_9fa48("1016");
          throw new TypeError(stryMutAct_9fa48("1017") ? "" : (stryCov_9fa48("1017"), "Authority evidence issuer Tenant must match its path"));
        }
      }
      if (stryMutAct_9fa48("1020") ? bindingKey.length !== 0 : stryMutAct_9fa48("1019") ? false : stryMutAct_9fa48("1018") ? true : (stryCov_9fa48("1018", "1019", "1020"), bindingKey.length === 0)) {
        if (stryMutAct_9fa48("1021")) {
          {}
        } else {
          stryCov_9fa48("1021");
          throw new TypeError(stryMutAct_9fa48("1022") ? "" : (stryCov_9fa48("1022"), "Authority evidence Binding key must be nonblank"));
        }
      }
      this.#checkedAt = validDate(checkedAt, stryMutAct_9fa48("1023") ? "" : (stryCov_9fa48("1023"), "Authority check time"));
      if (stryMutAct_9fa48("1026") ? issuer.kind === "tenant" : stryMutAct_9fa48("1025") ? false : stryMutAct_9fa48("1024") ? true : (stryCov_9fa48("1024", "1025", "1026"), issuer.kind !== (stryMutAct_9fa48("1027") ? "" : (stryCov_9fa48("1027"), "tenant")))) {
        if (stryMutAct_9fa48("1028")) {
          {}
        } else {
          stryCov_9fa48("1028");
          throw new TypeError(stryMutAct_9fa48("1029") ? "" : (stryCov_9fa48("1029"), "Authority check evidence must be issued by a Tenant Actor"));
        }
      }
      Object.freeze(this);
    }
  }
  public static encode(record: AuthorityCheckEvidence): Uint8Array {
    if (stryMutAct_9fa48("1030")) {
      {}
    } else {
      stryCov_9fa48("1030");
      return AuthorityCheckEvidence.codec.encode(record);
    }
  }
  public static decode(bytes: Uint8Array): AuthorityCheckEvidence {
    if (stryMutAct_9fa48("1031")) {
      {}
    } else {
      stryCov_9fa48("1031");
      return AuthorityCheckEvidence.codec.decode(bytes);
    }
  }
  public get checkedAt(): Date {
    if (stryMutAct_9fa48("1032")) {
      {}
    } else {
      stryCov_9fa48("1032");
      return new Date(this.#checkedAt);
    }
  }
  public get allowed(): boolean {
    if (stryMutAct_9fa48("1033")) {
      {}
    } else {
      stryCov_9fa48("1033");
      return stryMutAct_9fa48("1036") ? this.decision !== "allow" : stryMutAct_9fa48("1035") ? false : stryMutAct_9fa48("1034") ? true : (stryCov_9fa48("1034", "1035", "1036"), this.decision === (stryMutAct_9fa48("1037") ? "" : (stryCov_9fa48("1037"), "allow")));
    }
  }
  public binds(request: AuthorityCheckRequest): boolean {
    if (stryMutAct_9fa48("1038")) {
      {}
    } else {
      stryCov_9fa48("1038");
      return stryMutAct_9fa48("1041") ? this.requestDigest.equals(request.digest()) && this.bindingKey === request.binding.key || this.bindingGeneration === request.binding.generation : stryMutAct_9fa48("1040") ? false : stryMutAct_9fa48("1039") ? true : (stryCov_9fa48("1039", "1040", "1041"), (stryMutAct_9fa48("1043") ? this.requestDigest.equals(request.digest()) || this.bindingKey === request.binding.key : stryMutAct_9fa48("1042") ? true : (stryCov_9fa48("1042", "1043"), this.requestDigest.equals(request.digest()) && (stryMutAct_9fa48("1045") ? this.bindingKey !== request.binding.key : stryMutAct_9fa48("1044") ? true : (stryCov_9fa48("1044", "1045"), this.bindingKey === request.binding.key)))) && (stryMutAct_9fa48("1047") ? this.bindingGeneration !== request.binding.generation : stryMutAct_9fa48("1046") ? true : (stryCov_9fa48("1046", "1047"), this.bindingGeneration === request.binding.generation)));
    }
  }
  public toData(): JsonObject {
    if (stryMutAct_9fa48("1048")) {
      {}
    } else {
      stryCov_9fa48("1048");
      return stryMutAct_9fa48("1049") ? {} : (stryCov_9fa48("1049"), {
        bindingGeneration: this.bindingGeneration,
        bindingKey: this.bindingKey,
        checkedAt: this.#checkedAt,
        decision: this.decision,
        issuer: stryMutAct_9fa48("1050") ? {} : (stryCov_9fa48("1050"), {
          id: this.issuer.id.value,
          kind: this.issuer.kind
        }),
        issuerTenant: this.issuerTenant.value,
        matchedAllow: this.matchedAllow.map(stryMutAct_9fa48("1051") ? () => undefined : (stryCov_9fa48("1051"), id => id.value)),
        matchedDeny: this.matchedDeny.map(stryMutAct_9fa48("1052") ? () => undefined : (stryCov_9fa48("1052"), id => id.value)),
        pathEpochs: this.pathEpochs.toData(),
        reason: this.reason,
        requestDigest: this.requestDigest.value
      });
    }
  }
  public static fromData(value: JsonValue | undefined): AuthorityCheckEvidence {
    if (stryMutAct_9fa48("1053")) {
      {}
    } else {
      stryCov_9fa48("1053");
      const object = requireObject(value, stryMutAct_9fa48("1054") ? "" : (stryCov_9fa48("1054"), "Authority check evidence"));
      requireExact(object, stryMutAct_9fa48("1055") ? [] : (stryCov_9fa48("1055"), [stryMutAct_9fa48("1056") ? "" : (stryCov_9fa48("1056"), "bindingGeneration"), stryMutAct_9fa48("1057") ? "" : (stryCov_9fa48("1057"), "bindingKey"), stryMutAct_9fa48("1058") ? "" : (stryCov_9fa48("1058"), "checkedAt"), stryMutAct_9fa48("1059") ? "" : (stryCov_9fa48("1059"), "decision"), stryMutAct_9fa48("1060") ? "" : (stryCov_9fa48("1060"), "issuer"), stryMutAct_9fa48("1061") ? "" : (stryCov_9fa48("1061"), "issuerTenant"), stryMutAct_9fa48("1062") ? "" : (stryCov_9fa48("1062"), "matchedAllow"), stryMutAct_9fa48("1063") ? "" : (stryCov_9fa48("1063"), "matchedDeny"), stryMutAct_9fa48("1064") ? "" : (stryCov_9fa48("1064"), "pathEpochs"), stryMutAct_9fa48("1065") ? "" : (stryCov_9fa48("1065"), "reason"), stryMutAct_9fa48("1066") ? "" : (stryCov_9fa48("1066"), "requestDigest")]), stryMutAct_9fa48("1067") ? "" : (stryCov_9fa48("1067"), "Authority check evidence"));
      const issuer = requireObject(object[stryMutAct_9fa48("1068") ? "" : (stryCov_9fa48("1068"), "issuer")], stryMutAct_9fa48("1069") ? "" : (stryCov_9fa48("1069"), "Authority evidence issuer"));
      requireExact(issuer, stryMutAct_9fa48("1070") ? [] : (stryCov_9fa48("1070"), [stryMutAct_9fa48("1071") ? "" : (stryCov_9fa48("1071"), "id"), stryMutAct_9fa48("1072") ? "" : (stryCov_9fa48("1072"), "kind")]), stryMutAct_9fa48("1073") ? "" : (stryCov_9fa48("1073"), "Authority evidence issuer"));
      const decision = requireDecision(object[stryMutAct_9fa48("1074") ? "" : (stryCov_9fa48("1074"), "decision")]);
      return new AuthorityCheckEvidence(new TenantId(requireString(object, stryMutAct_9fa48("1075") ? "" : (stryCov_9fa48("1075"), "issuerTenant"))), new ActorRef(requireActorKind(issuer[stryMutAct_9fa48("1076") ? "" : (stryCov_9fa48("1076"), "kind")]), new ActorId(requireString(issuer, stryMutAct_9fa48("1077") ? "" : (stryCov_9fa48("1077"), "id")))), new Digest(requireString(object, stryMutAct_9fa48("1078") ? "" : (stryCov_9fa48("1078"), "requestDigest"))), requireString(object, stryMutAct_9fa48("1079") ? "" : (stryCov_9fa48("1079"), "bindingKey")), requireSafeInteger(object, stryMutAct_9fa48("1080") ? "" : (stryCov_9fa48("1080"), "bindingGeneration")), decision, requireReason(object[stryMutAct_9fa48("1081") ? "" : (stryCov_9fa48("1081"), "reason")]), decodeGrantIds(object[stryMutAct_9fa48("1082") ? "" : (stryCov_9fa48("1082"), "matchedAllow")], stryMutAct_9fa48("1083") ? "" : (stryCov_9fa48("1083"), "Matched allow Grants")), decodeGrantIds(object[stryMutAct_9fa48("1084") ? "" : (stryCov_9fa48("1084"), "matchedDeny")], stryMutAct_9fa48("1085") ? "" : (stryCov_9fa48("1085"), "Matched deny Grants")), PathEpochEvidence.fromData(object[stryMutAct_9fa48("1086") ? "" : (stryCov_9fa48("1086"), "pathEpochs")]), new Date(requireSafeInteger(object, stryMutAct_9fa48("1087") ? "" : (stryCov_9fa48("1087"), "checkedAt"))));
    }
  }
}
export type AuthorityAdmission = AuthorityCheckEvidence;
function encodeIntent(intent: AuthorityOperationIntent): JsonObject {
  if (stryMutAct_9fa48("1088")) {
    {}
  } else {
    stryCov_9fa48("1088");
    return stryMutAct_9fa48("1089") ? {} : (stryCov_9fa48("1089"), {
      arguments: intent.arguments,
      argumentsDigest: intent.argumentsDigest.value,
      facet: intent.facet.value,
      impact: intent.impact,
      operation: intent.operation
    });
  }
}
function decodeIntent(value: JsonValue | undefined): AuthorityOperationIntent {
  if (stryMutAct_9fa48("1090")) {
    {}
  } else {
    stryCov_9fa48("1090");
    const object = requireObject(value, stryMutAct_9fa48("1091") ? "" : (stryCov_9fa48("1091"), "Authority operation intent"));
    requireExact(object, stryMutAct_9fa48("1092") ? [] : (stryCov_9fa48("1092"), [stryMutAct_9fa48("1093") ? "" : (stryCov_9fa48("1093"), "arguments"), stryMutAct_9fa48("1094") ? "" : (stryCov_9fa48("1094"), "argumentsDigest"), stryMutAct_9fa48("1095") ? "" : (stryCov_9fa48("1095"), "facet"), stryMutAct_9fa48("1096") ? "" : (stryCov_9fa48("1096"), "impact"), stryMutAct_9fa48("1097") ? "" : (stryCov_9fa48("1097"), "operation")]), stryMutAct_9fa48("1098") ? "" : (stryCov_9fa48("1098"), "Authority operation intent"));
    const argumentsValue = requireObject(object[stryMutAct_9fa48("1099") ? "" : (stryCov_9fa48("1099"), "arguments")], stryMutAct_9fa48("1100") ? "" : (stryCov_9fa48("1100"), "Authority operation arguments"));
    return Object.freeze(stryMutAct_9fa48("1101") ? {} : (stryCov_9fa48("1101"), {
      facet: new FacetRef(requireString(object, stryMutAct_9fa48("1102") ? "" : (stryCov_9fa48("1102"), "facet"))),
      operation: requireString(object, stryMutAct_9fa48("1103") ? "" : (stryCov_9fa48("1103"), "operation")),
      impact: requireImpact(object[stryMutAct_9fa48("1104") ? "" : (stryCov_9fa48("1104"), "impact")]),
      arguments: canonicalJson(argumentsValue),
      argumentsDigest: new Digest(requireString(object, stryMutAct_9fa48("1105") ? "" : (stryCov_9fa48("1105"), "argumentsDigest")))
    }));
  }
}
function canonicalGrantIds(ids: readonly GrantId[]): readonly GrantId[] {
  if (stryMutAct_9fa48("1106")) {
    {}
  } else {
    stryCov_9fa48("1106");
    const ordered = stryMutAct_9fa48("1107") ? [...ids] : (stryCov_9fa48("1107"), (stryMutAct_9fa48("1108") ? [] : (stryCov_9fa48("1108"), [...ids])).sort(stryMutAct_9fa48("1109") ? () => undefined : (stryCov_9fa48("1109"), (left, right) => left.value.localeCompare(right.value))));
    if (stryMutAct_9fa48("1112") ? new Set(ordered.map(id => id.value)).size === ordered.length : stryMutAct_9fa48("1111") ? false : stryMutAct_9fa48("1110") ? true : (stryCov_9fa48("1110", "1111", "1112"), new Set(ordered.map(stryMutAct_9fa48("1113") ? () => undefined : (stryCov_9fa48("1113"), id => id.value))).size !== ordered.length)) {
      if (stryMutAct_9fa48("1114")) {
        {}
      } else {
        stryCov_9fa48("1114");
        throw new TypeError(stryMutAct_9fa48("1115") ? "" : (stryCov_9fa48("1115"), "Authority Grant evidence must be unique"));
      }
    }
    return Object.freeze(ordered);
  }
}
function decodeGrantIds(value: JsonValue | undefined, subject: string): readonly GrantId[] {
  if (stryMutAct_9fa48("1116")) {
    {}
  } else {
    stryCov_9fa48("1116");
    return requireArray(value, subject).map((entry, index) => {
      if (stryMutAct_9fa48("1117")) {
        {}
      } else {
        stryCov_9fa48("1117");
        if (stryMutAct_9fa48("1120") ? typeof entry === "string" : stryMutAct_9fa48("1119") ? false : stryMutAct_9fa48("1118") ? true : (stryCov_9fa48("1118", "1119", "1120"), typeof entry !== (stryMutAct_9fa48("1121") ? "" : (stryCov_9fa48("1121"), "string")))) throw new TypeError(stryMutAct_9fa48("1122") ? `` : (stryCov_9fa48("1122"), `${subject} entry ${index} must be a string`));
        return new GrantId(entry);
      }
    });
  }
}
function requireActorKind(value: JsonValue | undefined): ActorKind {
  if (stryMutAct_9fa48("1123")) {
    {}
  } else {
    stryCov_9fa48("1123");
    if (stryMutAct_9fa48("1126") ? (value === "tenant" || value === "workspace" || value === "run" || value === "environment") && value === "slate" : stryMutAct_9fa48("1125") ? false : stryMutAct_9fa48("1124") ? true : (stryCov_9fa48("1124", "1125", "1126"), (stryMutAct_9fa48("1128") ? (value === "tenant" || value === "workspace" || value === "run") && value === "environment" : stryMutAct_9fa48("1127") ? false : (stryCov_9fa48("1127", "1128"), (stryMutAct_9fa48("1130") ? (value === "tenant" || value === "workspace") && value === "run" : stryMutAct_9fa48("1129") ? false : (stryCov_9fa48("1129", "1130"), (stryMutAct_9fa48("1132") ? value === "tenant" && value === "workspace" : stryMutAct_9fa48("1131") ? false : (stryCov_9fa48("1131", "1132"), (stryMutAct_9fa48("1134") ? value !== "tenant" : stryMutAct_9fa48("1133") ? false : (stryCov_9fa48("1133", "1134"), value === (stryMutAct_9fa48("1135") ? "" : (stryCov_9fa48("1135"), "tenant")))) || (stryMutAct_9fa48("1137") ? value !== "workspace" : stryMutAct_9fa48("1136") ? false : (stryCov_9fa48("1136", "1137"), value === (stryMutAct_9fa48("1138") ? "" : (stryCov_9fa48("1138"), "workspace")))))) || (stryMutAct_9fa48("1140") ? value !== "run" : stryMutAct_9fa48("1139") ? false : (stryCov_9fa48("1139", "1140"), value === (stryMutAct_9fa48("1141") ? "" : (stryCov_9fa48("1141"), "run")))))) || (stryMutAct_9fa48("1143") ? value !== "environment" : stryMutAct_9fa48("1142") ? false : (stryCov_9fa48("1142", "1143"), value === (stryMutAct_9fa48("1144") ? "" : (stryCov_9fa48("1144"), "environment")))))) || (stryMutAct_9fa48("1146") ? value !== "slate" : stryMutAct_9fa48("1145") ? false : (stryCov_9fa48("1145", "1146"), value === (stryMutAct_9fa48("1147") ? "" : (stryCov_9fa48("1147"), "slate")))))) return value;
    throw new TypeError(stryMutAct_9fa48("1148") ? "" : (stryCov_9fa48("1148"), "Authority Actor kind is invalid"));
  }
}
function requireImpact(value: JsonValue | undefined): Impact {
  if (stryMutAct_9fa48("1149")) {
    {}
  } else {
    stryCov_9fa48("1149");
    if (stryMutAct_9fa48("1152") ? (value === "observe" || value === "mutate" || value === "externalSend" || value === "execute" || value === "delegate") && value === "administer" : stryMutAct_9fa48("1151") ? false : stryMutAct_9fa48("1150") ? true : (stryCov_9fa48("1150", "1151", "1152"), (stryMutAct_9fa48("1154") ? (value === "observe" || value === "mutate" || value === "externalSend" || value === "execute") && value === "delegate" : stryMutAct_9fa48("1153") ? false : (stryCov_9fa48("1153", "1154"), (stryMutAct_9fa48("1156") ? (value === "observe" || value === "mutate" || value === "externalSend") && value === "execute" : stryMutAct_9fa48("1155") ? false : (stryCov_9fa48("1155", "1156"), (stryMutAct_9fa48("1158") ? (value === "observe" || value === "mutate") && value === "externalSend" : stryMutAct_9fa48("1157") ? false : (stryCov_9fa48("1157", "1158"), (stryMutAct_9fa48("1160") ? value === "observe" && value === "mutate" : stryMutAct_9fa48("1159") ? false : (stryCov_9fa48("1159", "1160"), (stryMutAct_9fa48("1162") ? value !== "observe" : stryMutAct_9fa48("1161") ? false : (stryCov_9fa48("1161", "1162"), value === (stryMutAct_9fa48("1163") ? "" : (stryCov_9fa48("1163"), "observe")))) || (stryMutAct_9fa48("1165") ? value !== "mutate" : stryMutAct_9fa48("1164") ? false : (stryCov_9fa48("1164", "1165"), value === (stryMutAct_9fa48("1166") ? "" : (stryCov_9fa48("1166"), "mutate")))))) || (stryMutAct_9fa48("1168") ? value !== "externalSend" : stryMutAct_9fa48("1167") ? false : (stryCov_9fa48("1167", "1168"), value === (stryMutAct_9fa48("1169") ? "" : (stryCov_9fa48("1169"), "externalSend")))))) || (stryMutAct_9fa48("1171") ? value !== "execute" : stryMutAct_9fa48("1170") ? false : (stryCov_9fa48("1170", "1171"), value === (stryMutAct_9fa48("1172") ? "" : (stryCov_9fa48("1172"), "execute")))))) || (stryMutAct_9fa48("1174") ? value !== "delegate" : stryMutAct_9fa48("1173") ? false : (stryCov_9fa48("1173", "1174"), value === (stryMutAct_9fa48("1175") ? "" : (stryCov_9fa48("1175"), "delegate")))))) || (stryMutAct_9fa48("1177") ? value !== "administer" : stryMutAct_9fa48("1176") ? false : (stryCov_9fa48("1176", "1177"), value === (stryMutAct_9fa48("1178") ? "" : (stryCov_9fa48("1178"), "administer")))))) return value;
    throw new TypeError(stryMutAct_9fa48("1179") ? "" : (stryCov_9fa48("1179"), "Authority impact is invalid"));
  }
}
function requireDecision(value: JsonValue | undefined): "allow" | "deny" {
  if (stryMutAct_9fa48("1180")) {
    {}
  } else {
    stryCov_9fa48("1180");
    if (stryMutAct_9fa48("1183") ? value === "allow" && value === "deny" : stryMutAct_9fa48("1182") ? false : stryMutAct_9fa48("1181") ? true : (stryCov_9fa48("1181", "1182", "1183"), (stryMutAct_9fa48("1185") ? value !== "allow" : stryMutAct_9fa48("1184") ? false : (stryCov_9fa48("1184", "1185"), value === (stryMutAct_9fa48("1186") ? "" : (stryCov_9fa48("1186"), "allow")))) || (stryMutAct_9fa48("1188") ? value !== "deny" : stryMutAct_9fa48("1187") ? false : (stryCov_9fa48("1187", "1188"), value === (stryMutAct_9fa48("1189") ? "" : (stryCov_9fa48("1189"), "deny")))))) return value;
    throw new TypeError(stryMutAct_9fa48("1190") ? "" : (stryCov_9fa48("1190"), "Authority decision is invalid"));
  }
}
function requireReason(value: JsonValue | undefined): AuthorityDecisionReason {
  if (stryMutAct_9fa48("1191")) {
    {}
  } else {
    stryCov_9fa48("1191");
    const reasons: readonly AuthorityDecisionReason[] = stryMutAct_9fa48("1192") ? [] : (stryCov_9fa48("1192"), [stryMutAct_9fa48("1193") ? "" : (stryCov_9fa48("1193"), "allowed"), stryMutAct_9fa48("1194") ? "" : (stryCov_9fa48("1194"), "missingPrincipal"), stryMutAct_9fa48("1195") ? "" : (stryCov_9fa48("1195"), "inactivePrincipal"), stryMutAct_9fa48("1196") ? "" : (stryCov_9fa48("1196"), "invalidBinding"), stryMutAct_9fa48("1197") ? "" : (stryCov_9fa48("1197"), "missingGrant"), stryMutAct_9fa48("1198") ? "" : (stryCov_9fa48("1198"), "revokedGrant"), stryMutAct_9fa48("1199") ? "" : (stryCov_9fa48("1199"), "invalidDelegation"), stryMutAct_9fa48("1200") ? "" : (stryCov_9fa48("1200"), "guestElevation"), stryMutAct_9fa48("1201") ? "" : (stryCov_9fa48("1201"), "guestVerificationExpired"), stryMutAct_9fa48("1202") ? "" : (stryCov_9fa48("1202"), "noMatchingAllow"), stryMutAct_9fa48("1203") ? "" : (stryCov_9fa48("1203"), "matchingDeny"), stryMutAct_9fa48("1204") ? "" : (stryCov_9fa48("1204"), "stalePath")]);
    if (stryMutAct_9fa48("1207") ? typeof value === "string" || reasons.includes(value as AuthorityDecisionReason) : stryMutAct_9fa48("1206") ? false : stryMutAct_9fa48("1205") ? true : (stryCov_9fa48("1205", "1206", "1207"), (stryMutAct_9fa48("1209") ? typeof value !== "string" : stryMutAct_9fa48("1208") ? true : (stryCov_9fa48("1208", "1209"), typeof value === (stryMutAct_9fa48("1210") ? "" : (stryCov_9fa48("1210"), "string")))) && reasons.includes(value as AuthorityDecisionReason))) {
      if (stryMutAct_9fa48("1211")) {
        {}
      } else {
        stryCov_9fa48("1211");
        return value as AuthorityDecisionReason;
      }
    }
    throw new TypeError(stryMutAct_9fa48("1212") ? "" : (stryCov_9fa48("1212"), "Authority decision reason is invalid"));
  }
}
function requireSafeNonnegative(value: number, subject: string): void {
  if (stryMutAct_9fa48("1213")) {
    {}
  } else {
    stryCov_9fa48("1213");
    if (stryMutAct_9fa48("1216") ? !Number.isSafeInteger(value) && value < 0 : stryMutAct_9fa48("1215") ? false : stryMutAct_9fa48("1214") ? true : (stryCov_9fa48("1214", "1215", "1216"), (stryMutAct_9fa48("1217") ? Number.isSafeInteger(value) : (stryCov_9fa48("1217"), !Number.isSafeInteger(value))) || (stryMutAct_9fa48("1220") ? value >= 0 : stryMutAct_9fa48("1219") ? value <= 0 : stryMutAct_9fa48("1218") ? false : (stryCov_9fa48("1218", "1219", "1220"), value < 0)))) throw new TypeError(stryMutAct_9fa48("1221") ? `` : (stryCov_9fa48("1221"), `${subject} is invalid`));
  }
}
function validDate(value: Date, subject: string): number {
  if (stryMutAct_9fa48("1222")) {
    {}
  } else {
    stryCov_9fa48("1222");
    const time = value.getTime();
    if (stryMutAct_9fa48("1225") ? !Number.isSafeInteger(time) && time < 0 : stryMutAct_9fa48("1224") ? false : stryMutAct_9fa48("1223") ? true : (stryCov_9fa48("1223", "1224", "1225"), (stryMutAct_9fa48("1226") ? Number.isSafeInteger(time) : (stryCov_9fa48("1226"), !Number.isSafeInteger(time))) || (stryMutAct_9fa48("1229") ? time >= 0 : stryMutAct_9fa48("1228") ? time <= 0 : stryMutAct_9fa48("1227") ? false : (stryCov_9fa48("1227", "1228", "1229"), time < 0)))) throw new TypeError(stryMutAct_9fa48("1230") ? `` : (stryCov_9fa48("1230"), `${subject} is invalid`));
    return time;
  }
}