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
import { RunId, TurnId, type LeaseToken } from "../agents";
import { Digest, RecordCodec, Revision, type JsonValue, type RecordVersion } from "../core";
import { POLICY_IMPACTS, PackagePin } from "../definition";
import { AgentCoreError } from "../errors";
import { BindingName, FacetRef, OperationRef, type Impact, type ProtectionDomain } from "../facets";
import { PrincipalId, PrincipalRef, TenantId } from "../identity";
import { ClaimWorkerId, ItemClaimId } from "../invocation-references";
import { InvocationId } from "../interaction-references";
import { canonicalJsonEqual, requireExact, requireObject, requireSafeInteger, requireString, type JsonObject } from "./data";
import { decodeDomain, encodeDomain } from "./binding";
import { PathEpochEvidence } from "./epoch";
const EXPECTATION_FIELDS = Object.freeze(stryMutAct_9fa48("2814") ? [] : (stryCov_9fa48("2814"), [stryMutAct_9fa48("2815") ? "" : (stryCov_9fa48("2815"), "argumentsDigest"), stryMutAct_9fa48("2816") ? "" : (stryCov_9fa48("2816"), "authority"), stryMutAct_9fa48("2817") ? "" : (stryCov_9fa48("2817"), "binding"), stryMutAct_9fa48("2818") ? "" : (stryCov_9fa48("2818"), "claim"), stryMutAct_9fa48("2819") ? "" : (stryCov_9fa48("2819"), "claimOwner"), stryMutAct_9fa48("2820") ? "" : (stryCov_9fa48("2820"), "facet"), stryMutAct_9fa48("2821") ? "" : (stryCov_9fa48("2821"), "impact"), stryMutAct_9fa48("2822") ? "" : (stryCov_9fa48("2822"), "intentDigest"), stryMutAct_9fa48("2823") ? "" : (stryCov_9fa48("2823"), "invocation"), stryMutAct_9fa48("2824") ? "" : (stryCov_9fa48("2824"), "itemIndex"), stryMutAct_9fa48("2825") ? "" : (stryCov_9fa48("2825"), "itemKey"), stryMutAct_9fa48("2826") ? "" : (stryCov_9fa48("2826"), "lease"), stryMutAct_9fa48("2827") ? "" : (stryCov_9fa48("2827"), "operation"), stryMutAct_9fa48("2828") ? "" : (stryCov_9fa48("2828"), "package"), stryMutAct_9fa48("2829") ? "" : (stryCov_9fa48("2829"), "pathEpochs"), stryMutAct_9fa48("2830") ? "" : (stryCov_9fa48("2830"), "principal"), stryMutAct_9fa48("2831") ? "" : (stryCov_9fa48("2831"), "reservation"), stryMutAct_9fa48("2832") ? "" : (stryCov_9fa48("2832"), "source"), stryMutAct_9fa48("2833") ? "" : (stryCov_9fa48("2833"), "target"), stryMutAct_9fa48("2834") ? "" : (stryCov_9fa48("2834"), "tenant"), stryMutAct_9fa48("2835") ? "" : (stryCov_9fa48("2835"), "issuer"), stryMutAct_9fa48("2836") ? "" : (stryCov_9fa48("2836"), "attemptOrdinal")]));
export interface AuthorityPermitTarget {
  readonly actor: ActorRef;
  readonly fence: number;
  readonly domain: ProtectionDomain;
}
export interface AuthorityPermitBinding {
  readonly name: BindingName;
  readonly generation: Revision;
}
export interface AuthorityPermitReservation {
  readonly run: RunId;
  readonly registryEpoch: number;
  readonly obligation: {
    readonly kind: "invocationItem";
    readonly invocation: InvocationId;
    readonly itemIndex: number;
    readonly itemKey: string;
  };
}
export type AuthorityPermitClaimOwner = {
  readonly kind: "executor";
  readonly token: LeaseToken;
  readonly worker: ClaimWorkerId;
} | {
  readonly kind: "system";
  readonly actor: ActorRef;
  readonly worker: ClaimWorkerId;
};
export type AuthorityPermitSource = {
  readonly kind: "initiator";
  readonly principal: PrincipalRef;
  readonly binding: BindingName;
} | {
  readonly kind: "delegated";
  readonly principal: PrincipalRef;
  readonly binding: BindingName;
};
export interface AuthorityPermitExpectationInit {
  readonly tenant: TenantId;
  readonly issuer: ActorRef;
  readonly source: ActorRef;
  readonly target: AuthorityPermitTarget;
  readonly principal: PrincipalRef;
  readonly binding: AuthorityPermitBinding;
  readonly facet: FacetRef;
  readonly operation: OperationRef;
  readonly package: PackagePin;
  readonly impact: Impact;
  readonly invocation: InvocationId;
  readonly reservation: AuthorityPermitReservation;
  readonly itemIndex: number;
  readonly attemptOrdinal: number;
  readonly claim: ItemClaimId;
  readonly claimOwner: AuthorityPermitClaimOwner;
  readonly itemKey: string;
  readonly argumentsDigest: Digest;
  readonly intentDigest: Digest;
  readonly pathEpochs: PathEpochEvidence;
  readonly authority: AuthorityPermitSource;
  readonly lease?: LeaseToken | undefined;
}
export class AuthorityPermitExpectation {
  public readonly tenant: TenantId;
  public readonly issuer: ActorRef;
  public readonly source: ActorRef;
  public readonly target: AuthorityPermitTarget;
  public readonly principal: PrincipalRef;
  public readonly binding: AuthorityPermitBinding;
  public readonly facet: FacetRef;
  public readonly operation: OperationRef;
  public readonly package: PackagePin;
  public readonly impact: Impact;
  public readonly invocation: InvocationId;
  public readonly reservation: AuthorityPermitReservation;
  public readonly itemIndex: number;
  public readonly attemptOrdinal: number;
  public readonly claim: ItemClaimId;
  public readonly claimOwner: AuthorityPermitClaimOwner;
  public readonly itemKey: string;
  public readonly argumentsDigest: Digest;
  public readonly intentDigest: Digest;
  public readonly pathEpochs: PathEpochEvidence;
  public readonly authority: AuthorityPermitSource;
  public readonly lease: LeaseToken | undefined;
  public constructor(init: AuthorityPermitExpectationInit) {
    if (stryMutAct_9fa48("2837")) {
      {}
    } else {
      stryCov_9fa48("2837");
      requireIndex(init.target.fence, stryMutAct_9fa48("2838") ? "" : (stryCov_9fa48("2838"), "Authority permit target fence"));
      requireIndex(init.binding.generation.value, stryMutAct_9fa48("2839") ? "" : (stryCov_9fa48("2839"), "Authority permit Binding generation"));
      requireIndex(init.itemIndex, stryMutAct_9fa48("2840") ? "" : (stryCov_9fa48("2840"), "Authority permit item index"));
      requireIndex(init.attemptOrdinal, stryMutAct_9fa48("2841") ? "" : (stryCov_9fa48("2841"), "Authority permit attempt ordinal"));
      requireIndex(init.reservation.registryEpoch, stryMutAct_9fa48("2842") ? "" : (stryCov_9fa48("2842"), "Authority permit reservation epoch"));
      requireNonblank(init.itemKey, stryMutAct_9fa48("2843") ? "" : (stryCov_9fa48("2843"), "Authority permit item key"));
      if (stryMutAct_9fa48("2846") ? init.issuer.kind === "tenant" : stryMutAct_9fa48("2845") ? false : stryMutAct_9fa48("2844") ? true : (stryCov_9fa48("2844", "2845", "2846"), init.issuer.kind !== (stryMutAct_9fa48("2847") ? "" : (stryCov_9fa48("2847"), "tenant")))) {
        if (stryMutAct_9fa48("2848")) {
          {}
        } else {
          stryCov_9fa48("2848");
          throw new TypeError(stryMutAct_9fa48("2849") ? "" : (stryCov_9fa48("2849"), "Authority permits must be issued by a Tenant Actor"));
        }
      }
      if (stryMutAct_9fa48("2852") ? !init.tenant.equals(init.principal.tenantId) && !init.tenant.equals(init.pathEpochs.path[0].scope.tenantId) : stryMutAct_9fa48("2851") ? false : stryMutAct_9fa48("2850") ? true : (stryCov_9fa48("2850", "2851", "2852"), (stryMutAct_9fa48("2853") ? init.tenant.equals(init.principal.tenantId) : (stryCov_9fa48("2853"), !init.tenant.equals(init.principal.tenantId))) || (stryMutAct_9fa48("2854") ? init.tenant.equals(init.pathEpochs.path[0].scope.tenantId) : (stryCov_9fa48("2854"), !init.tenant.equals(init.pathEpochs.path[0].scope.tenantId))))) {
        if (stryMutAct_9fa48("2855")) {
          {}
        } else {
          stryCov_9fa48("2855");
          throw new TypeError(stryMutAct_9fa48("2856") ? "" : (stryCov_9fa48("2856"), "Authority permit Tenant must qualify its principal and path"));
        }
      }
      if (stryMutAct_9fa48("2859") ? !init.authority.principal.equals(init.principal) && !init.authority.binding.equals(init.binding.name) : stryMutAct_9fa48("2858") ? false : stryMutAct_9fa48("2857") ? true : (stryCov_9fa48("2857", "2858", "2859"), (stryMutAct_9fa48("2860") ? init.authority.principal.equals(init.principal) : (stryCov_9fa48("2860"), !init.authority.principal.equals(init.principal))) || (stryMutAct_9fa48("2861") ? init.authority.binding.equals(init.binding.name) : (stryCov_9fa48("2861"), !init.authority.binding.equals(init.binding.name))))) {
        if (stryMutAct_9fa48("2862")) {
          {}
        } else {
          stryCov_9fa48("2862");
          throw new TypeError(stryMutAct_9fa48("2863") ? "" : (stryCov_9fa48("2863"), "Authority permit source must match its principal and Binding"));
        }
      }
      const obligation = init.reservation.obligation;
      if (stryMutAct_9fa48("2866") ? (obligation.kind !== "invocationItem" || !obligation.invocation.equals(init.invocation) || obligation.itemIndex !== init.itemIndex) && obligation.itemKey !== init.itemKey : stryMutAct_9fa48("2865") ? false : stryMutAct_9fa48("2864") ? true : (stryCov_9fa48("2864", "2865", "2866"), (stryMutAct_9fa48("2868") ? (obligation.kind !== "invocationItem" || !obligation.invocation.equals(init.invocation)) && obligation.itemIndex !== init.itemIndex : stryMutAct_9fa48("2867") ? false : (stryCov_9fa48("2867", "2868"), (stryMutAct_9fa48("2870") ? obligation.kind !== "invocationItem" && !obligation.invocation.equals(init.invocation) : stryMutAct_9fa48("2869") ? false : (stryCov_9fa48("2869", "2870"), (stryMutAct_9fa48("2872") ? obligation.kind === "invocationItem" : stryMutAct_9fa48("2871") ? false : (stryCov_9fa48("2871", "2872"), obligation.kind !== (stryMutAct_9fa48("2873") ? "" : (stryCov_9fa48("2873"), "invocationItem")))) || (stryMutAct_9fa48("2874") ? obligation.invocation.equals(init.invocation) : (stryCov_9fa48("2874"), !obligation.invocation.equals(init.invocation))))) || (stryMutAct_9fa48("2876") ? obligation.itemIndex === init.itemIndex : stryMutAct_9fa48("2875") ? false : (stryCov_9fa48("2875", "2876"), obligation.itemIndex !== init.itemIndex)))) || (stryMutAct_9fa48("2878") ? obligation.itemKey === init.itemKey : stryMutAct_9fa48("2877") ? false : (stryCov_9fa48("2877", "2878"), obligation.itemKey !== init.itemKey)))) {
        if (stryMutAct_9fa48("2879")) {
          {}
        } else {
          stryCov_9fa48("2879");
          throw new TypeError(stryMutAct_9fa48("2880") ? "" : (stryCov_9fa48("2880"), "Authority permit reservation must match its exact invocation item"));
        }
      }
      if (stryMutAct_9fa48("2883") ? init.lease !== undefined || !init.lease.holder.equals(init.principal.principalId) : stryMutAct_9fa48("2882") ? false : stryMutAct_9fa48("2881") ? true : (stryCov_9fa48("2881", "2882", "2883"), (stryMutAct_9fa48("2885") ? init.lease === undefined : stryMutAct_9fa48("2884") ? true : (stryCov_9fa48("2884", "2885"), init.lease !== undefined)) && (stryMutAct_9fa48("2886") ? init.lease.holder.equals(init.principal.principalId) : (stryCov_9fa48("2886"), !init.lease.holder.equals(init.principal.principalId))))) {
        if (stryMutAct_9fa48("2887")) {
          {}
        } else {
          stryCov_9fa48("2887");
          throw new TypeError(stryMutAct_9fa48("2888") ? "" : (stryCov_9fa48("2888"), "Authority permit lease holder must match its qualified principal"));
        }
      }
      if (stryMutAct_9fa48("2891") ? false : stryMutAct_9fa48("2890") ? true : stryMutAct_9fa48("2889") ? POLICY_IMPACTS.includes(init.impact) : (stryCov_9fa48("2889", "2890", "2891"), !POLICY_IMPACTS.includes(init.impact))) {
        if (stryMutAct_9fa48("2892")) {
          {}
        } else {
          stryCov_9fa48("2892");
          throw new TypeError(stryMutAct_9fa48("2893") ? "" : (stryCov_9fa48("2893"), "Authority permit impact is invalid"));
        }
      }
      this.tenant = init.tenant;
      this.issuer = copyActor(init.issuer);
      this.source = copyActor(init.source);
      this.target = copyTarget(init.target);
      this.principal = new PrincipalRef(init.principal.tenantId, init.principal.principalId);
      this.binding = Object.freeze(stryMutAct_9fa48("2894") ? {} : (stryCov_9fa48("2894"), {
        name: init.binding.name,
        generation: new Revision(init.binding.generation.value)
      }));
      this.facet = init.facet;
      this.operation = init.operation;
      this.package = PackagePin.fromData(init.package.toData());
      this.impact = init.impact;
      this.invocation = init.invocation;
      this.reservation = copyReservation(init.reservation);
      this.itemIndex = init.itemIndex;
      this.attemptOrdinal = init.attemptOrdinal;
      this.claim = init.claim;
      this.claimOwner = copyClaimOwner(init.claimOwner);
      this.itemKey = init.itemKey;
      this.argumentsDigest = init.argumentsDigest;
      this.intentDigest = init.intentDigest;
      this.pathEpochs = PathEpochEvidence.fromData(init.pathEpochs.toData());
      this.authority = copyAuthority(init.authority);
      this.lease = (stryMutAct_9fa48("2897") ? init.lease !== undefined : stryMutAct_9fa48("2896") ? false : stryMutAct_9fa48("2895") ? true : (stryCov_9fa48("2895", "2896", "2897"), init.lease === undefined)) ? undefined : copyLease(init.lease);
      Object.freeze(this);
    }
  }
  public equals(other: AuthorityPermitExpectation): boolean {
    if (stryMutAct_9fa48("2898")) {
      {}
    } else {
      stryCov_9fa48("2898");
      return canonicalJsonEqual(this.toData(), other.toData());
    }
  }
  public toData(): JsonObject {
    if (stryMutAct_9fa48("2899")) {
      {}
    } else {
      stryCov_9fa48("2899");
      return stryMutAct_9fa48("2900") ? {} : (stryCov_9fa48("2900"), {
        argumentsDigest: this.argumentsDigest.value,
        attemptOrdinal: this.attemptOrdinal,
        authority: encodeAuthority(this.authority),
        binding: stryMutAct_9fa48("2901") ? {} : (stryCov_9fa48("2901"), {
          generation: this.binding.generation.value,
          name: this.binding.name.value
        }),
        claim: this.claim.value,
        claimOwner: encodeClaimOwner(this.claimOwner),
        facet: this.facet.value,
        impact: this.impact,
        intentDigest: this.intentDigest.value,
        invocation: this.invocation.value,
        itemIndex: this.itemIndex,
        itemKey: this.itemKey,
        issuer: encodeActor(this.issuer),
        lease: (stryMutAct_9fa48("2904") ? this.lease !== undefined : stryMutAct_9fa48("2903") ? false : stryMutAct_9fa48("2902") ? true : (stryCov_9fa48("2902", "2903", "2904"), this.lease === undefined)) ? null : encodeLease(this.lease),
        operation: this.operation.value,
        package: this.package.toData(),
        pathEpochs: this.pathEpochs.toData(),
        principal: encodePrincipal(this.principal),
        reservation: encodeReservation(this.reservation),
        source: encodeActor(this.source),
        target: stryMutAct_9fa48("2905") ? {} : (stryCov_9fa48("2905"), {
          actor: encodeActor(this.target.actor),
          domain: encodeDomain(this.target.domain),
          fence: this.target.fence
        }),
        tenant: this.tenant.value
      });
    }
  }
  public static fromData(value: JsonValue | undefined): AuthorityPermitExpectation {
    if (stryMutAct_9fa48("2906")) {
      {}
    } else {
      stryCov_9fa48("2906");
      const object = requireObject(value, stryMutAct_9fa48("2907") ? "" : (stryCov_9fa48("2907"), "Authority permit expectation"));
      requireExact(object, EXPECTATION_FIELDS, stryMutAct_9fa48("2908") ? "" : (stryCov_9fa48("2908"), "Authority permit expectation"));
      const binding = requireObject(object[stryMutAct_9fa48("2909") ? "" : (stryCov_9fa48("2909"), "binding")], stryMutAct_9fa48("2910") ? "" : (stryCov_9fa48("2910"), "Authority permit Binding"));
      const target = requireObject(object[stryMutAct_9fa48("2911") ? "" : (stryCov_9fa48("2911"), "target")], stryMutAct_9fa48("2912") ? "" : (stryCov_9fa48("2912"), "Authority permit target"));
      requireExact(binding, stryMutAct_9fa48("2913") ? [] : (stryCov_9fa48("2913"), [stryMutAct_9fa48("2914") ? "" : (stryCov_9fa48("2914"), "generation"), stryMutAct_9fa48("2915") ? "" : (stryCov_9fa48("2915"), "name")]), stryMutAct_9fa48("2916") ? "" : (stryCov_9fa48("2916"), "Authority permit Binding"));
      requireExact(target, stryMutAct_9fa48("2917") ? [] : (stryCov_9fa48("2917"), [stryMutAct_9fa48("2918") ? "" : (stryCov_9fa48("2918"), "actor"), stryMutAct_9fa48("2919") ? "" : (stryCov_9fa48("2919"), "domain"), stryMutAct_9fa48("2920") ? "" : (stryCov_9fa48("2920"), "fence")]), stryMutAct_9fa48("2921") ? "" : (stryCov_9fa48("2921"), "Authority permit target"));
      const lease = object[stryMutAct_9fa48("2922") ? "" : (stryCov_9fa48("2922"), "lease")];
      return new AuthorityPermitExpectation(stryMutAct_9fa48("2923") ? {} : (stryCov_9fa48("2923"), {
        tenant: new TenantId(requireString(object, stryMutAct_9fa48("2924") ? "" : (stryCov_9fa48("2924"), "tenant"))),
        issuer: decodeActor(object[stryMutAct_9fa48("2925") ? "" : (stryCov_9fa48("2925"), "issuer")]),
        source: decodeActor(object[stryMutAct_9fa48("2926") ? "" : (stryCov_9fa48("2926"), "source")]),
        target: stryMutAct_9fa48("2927") ? {} : (stryCov_9fa48("2927"), {
          actor: decodeActor(target[stryMutAct_9fa48("2928") ? "" : (stryCov_9fa48("2928"), "actor")]),
          fence: requireSafeInteger(target, stryMutAct_9fa48("2929") ? "" : (stryCov_9fa48("2929"), "fence")),
          domain: decodeDomain(target[stryMutAct_9fa48("2930") ? "" : (stryCov_9fa48("2930"), "domain")])
        }),
        principal: decodePrincipal(object[stryMutAct_9fa48("2931") ? "" : (stryCov_9fa48("2931"), "principal")]),
        binding: stryMutAct_9fa48("2932") ? {} : (stryCov_9fa48("2932"), {
          name: new BindingName(requireString(binding, stryMutAct_9fa48("2933") ? "" : (stryCov_9fa48("2933"), "name"))),
          generation: new Revision(requireSafeInteger(binding, stryMutAct_9fa48("2934") ? "" : (stryCov_9fa48("2934"), "generation")))
        }),
        facet: new FacetRef(requireString(object, stryMutAct_9fa48("2935") ? "" : (stryCov_9fa48("2935"), "facet"))),
        operation: new OperationRef(requireString(object, stryMutAct_9fa48("2936") ? "" : (stryCov_9fa48("2936"), "operation"))),
        package: PackagePin.fromData(object[stryMutAct_9fa48("2937") ? "" : (stryCov_9fa48("2937"), "package")]!),
        impact: requireImpact(object[stryMutAct_9fa48("2938") ? "" : (stryCov_9fa48("2938"), "impact")]),
        invocation: new InvocationId(requireString(object, stryMutAct_9fa48("2939") ? "" : (stryCov_9fa48("2939"), "invocation"))),
        reservation: decodeReservation(object[stryMutAct_9fa48("2940") ? "" : (stryCov_9fa48("2940"), "reservation")]),
        itemIndex: requireSafeInteger(object, stryMutAct_9fa48("2941") ? "" : (stryCov_9fa48("2941"), "itemIndex")),
        attemptOrdinal: requireSafeInteger(object, stryMutAct_9fa48("2942") ? "" : (stryCov_9fa48("2942"), "attemptOrdinal")),
        claim: new ItemClaimId(requireString(object, stryMutAct_9fa48("2943") ? "" : (stryCov_9fa48("2943"), "claim"))),
        claimOwner: decodeClaimOwner(object[stryMutAct_9fa48("2944") ? "" : (stryCov_9fa48("2944"), "claimOwner")]),
        itemKey: requireString(object, stryMutAct_9fa48("2945") ? "" : (stryCov_9fa48("2945"), "itemKey")),
        argumentsDigest: new Digest(requireString(object, stryMutAct_9fa48("2946") ? "" : (stryCov_9fa48("2946"), "argumentsDigest"))),
        intentDigest: new Digest(requireString(object, stryMutAct_9fa48("2947") ? "" : (stryCov_9fa48("2947"), "intentDigest"))),
        pathEpochs: PathEpochEvidence.fromData(object[stryMutAct_9fa48("2948") ? "" : (stryCov_9fa48("2948"), "pathEpochs")]),
        authority: decodeAuthority(object[stryMutAct_9fa48("2949") ? "" : (stryCov_9fa48("2949"), "authority")]),
        ...((stryMutAct_9fa48("2952") ? lease !== null : stryMutAct_9fa48("2951") ? false : stryMutAct_9fa48("2950") ? true : (stryCov_9fa48("2950", "2951", "2952"), lease === null)) ? {} : stryMutAct_9fa48("2953") ? {} : (stryCov_9fa48("2953"), {
          lease: decodeLease(lease)
        }))
      }));
    }
  }
}
export interface AuthorityPermitInit extends AuthorityPermitExpectationInit {
  readonly nonce: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}
class AuthorityPermitCodecV1 extends RecordCodec<AuthorityPermit> {
  public constructor() {
    if (stryMutAct_9fa48("2954")) {
      {}
    } else {
      stryCov_9fa48("2954");
      super(stryMutAct_9fa48("2955") ? "" : (stryCov_9fa48("2955"), "authority.permit"), stryMutAct_9fa48("2956") ? {} : (stryCov_9fa48("2956"), {
        major: 1,
        minor: 0
      }));
    }
  }
  protected encodePayload(permit: AuthorityPermit): JsonValue {
    if (stryMutAct_9fa48("2957")) {
      {}
    } else {
      stryCov_9fa48("2957");
      return permit.toData();
    }
  }
  protected decodePayload(payload: JsonValue, _version: RecordVersion): AuthorityPermit {
    if (stryMutAct_9fa48("2958")) {
      {}
    } else {
      stryCov_9fa48("2958");
      return AuthorityPermit.fromData(payload);
    }
  }
}
export class AuthorityPermit {
  public static readonly codec: RecordCodec<AuthorityPermit> = new AuthorityPermitCodecV1();
  readonly #issuedAt: number;
  readonly #expiresAt: number;
  public readonly expectation: AuthorityPermitExpectation;
  public readonly nonce: string;
  public constructor(init: AuthorityPermitInit) {
    if (stryMutAct_9fa48("2959")) {
      {}
    } else {
      stryCov_9fa48("2959");
      this.expectation = new AuthorityPermitExpectation(init);
      this.nonce = requireNonblank(init.nonce, stryMutAct_9fa48("2960") ? "" : (stryCov_9fa48("2960"), "Authority permit nonce"));
      this.#issuedAt = validTime(init.issuedAt, stryMutAct_9fa48("2961") ? "" : (stryCov_9fa48("2961"), "Authority permit issuance time"));
      this.#expiresAt = validTime(init.expiresAt, stryMutAct_9fa48("2962") ? "" : (stryCov_9fa48("2962"), "Authority permit expiry"));
      if (stryMutAct_9fa48("2966") ? this.#expiresAt > this.#issuedAt : stryMutAct_9fa48("2965") ? this.#expiresAt < this.#issuedAt : stryMutAct_9fa48("2964") ? false : stryMutAct_9fa48("2963") ? true : (stryCov_9fa48("2963", "2964", "2965", "2966"), this.#expiresAt <= this.#issuedAt)) {
        if (stryMutAct_9fa48("2967")) {
          {}
        } else {
          stryCov_9fa48("2967");
          throw new TypeError(stryMutAct_9fa48("2968") ? "" : (stryCov_9fa48("2968"), "Authority permit expiry must be after issuance"));
        }
      }
      Object.freeze(this);
    }
  }
  public static encode(permit: AuthorityPermit): Uint8Array {
    if (stryMutAct_9fa48("2969")) {
      {}
    } else {
      stryCov_9fa48("2969");
      return AuthorityPermit.codec.encode(permit);
    }
  }
  public static decode(bytes: Uint8Array): AuthorityPermit {
    if (stryMutAct_9fa48("2970")) {
      {}
    } else {
      stryCov_9fa48("2970");
      return AuthorityPermit.codec.decode(bytes);
    }
  }
  public get tenant(): TenantId {
    if (stryMutAct_9fa48("2971")) {
      {}
    } else {
      stryCov_9fa48("2971");
      return this.expectation.tenant;
    }
  }
  public get issuer(): ActorRef {
    if (stryMutAct_9fa48("2972")) {
      {}
    } else {
      stryCov_9fa48("2972");
      return this.expectation.issuer;
    }
  }
  public get source(): ActorRef {
    if (stryMutAct_9fa48("2973")) {
      {}
    } else {
      stryCov_9fa48("2973");
      return this.expectation.source;
    }
  }
  public get target(): AuthorityPermitTarget {
    if (stryMutAct_9fa48("2974")) {
      {}
    } else {
      stryCov_9fa48("2974");
      return this.expectation.target;
    }
  }
  public get principal(): PrincipalRef {
    if (stryMutAct_9fa48("2975")) {
      {}
    } else {
      stryCov_9fa48("2975");
      return this.expectation.principal;
    }
  }
  public get binding(): AuthorityPermitBinding {
    if (stryMutAct_9fa48("2976")) {
      {}
    } else {
      stryCov_9fa48("2976");
      return this.expectation.binding;
    }
  }
  public get facet(): FacetRef {
    if (stryMutAct_9fa48("2977")) {
      {}
    } else {
      stryCov_9fa48("2977");
      return this.expectation.facet;
    }
  }
  public get operation(): OperationRef {
    if (stryMutAct_9fa48("2978")) {
      {}
    } else {
      stryCov_9fa48("2978");
      return this.expectation.operation;
    }
  }
  public get package(): PackagePin {
    if (stryMutAct_9fa48("2979")) {
      {}
    } else {
      stryCov_9fa48("2979");
      return this.expectation.package;
    }
  }
  public get impact(): Impact {
    if (stryMutAct_9fa48("2980")) {
      {}
    } else {
      stryCov_9fa48("2980");
      return this.expectation.impact;
    }
  }
  public get invocation(): InvocationId {
    if (stryMutAct_9fa48("2981")) {
      {}
    } else {
      stryCov_9fa48("2981");
      return this.expectation.invocation;
    }
  }
  public get reservation(): AuthorityPermitReservation {
    if (stryMutAct_9fa48("2982")) {
      {}
    } else {
      stryCov_9fa48("2982");
      return this.expectation.reservation;
    }
  }
  public get itemIndex(): number {
    if (stryMutAct_9fa48("2983")) {
      {}
    } else {
      stryCov_9fa48("2983");
      return this.expectation.itemIndex;
    }
  }
  public get attemptOrdinal(): number {
    if (stryMutAct_9fa48("2984")) {
      {}
    } else {
      stryCov_9fa48("2984");
      return this.expectation.attemptOrdinal;
    }
  }
  public get claim(): ItemClaimId {
    if (stryMutAct_9fa48("2985")) {
      {}
    } else {
      stryCov_9fa48("2985");
      return this.expectation.claim;
    }
  }
  public get claimOwner(): AuthorityPermitClaimOwner {
    if (stryMutAct_9fa48("2986")) {
      {}
    } else {
      stryCov_9fa48("2986");
      return this.expectation.claimOwner;
    }
  }
  public get itemKey(): string {
    if (stryMutAct_9fa48("2987")) {
      {}
    } else {
      stryCov_9fa48("2987");
      return this.expectation.itemKey;
    }
  }
  public get argumentsDigest(): Digest {
    if (stryMutAct_9fa48("2988")) {
      {}
    } else {
      stryCov_9fa48("2988");
      return this.expectation.argumentsDigest;
    }
  }
  public get intentDigest(): Digest {
    if (stryMutAct_9fa48("2989")) {
      {}
    } else {
      stryCov_9fa48("2989");
      return this.expectation.intentDigest;
    }
  }
  public get pathEpochs(): PathEpochEvidence {
    if (stryMutAct_9fa48("2990")) {
      {}
    } else {
      stryCov_9fa48("2990");
      return this.expectation.pathEpochs;
    }
  }
  public get authority(): AuthorityPermitSource {
    if (stryMutAct_9fa48("2991")) {
      {}
    } else {
      stryCov_9fa48("2991");
      return this.expectation.authority;
    }
  }
  public get lease(): LeaseToken | undefined {
    if (stryMutAct_9fa48("2992")) {
      {}
    } else {
      stryCov_9fa48("2992");
      return this.expectation.lease;
    }
  }
  public get issuedAt(): Date {
    if (stryMutAct_9fa48("2993")) {
      {}
    } else {
      stryCov_9fa48("2993");
      return new Date(this.#issuedAt);
    }
  }
  public get expiresAt(): Date {
    if (stryMutAct_9fa48("2994")) {
      {}
    } else {
      stryCov_9fa48("2994");
      return new Date(this.#expiresAt);
    }
  }
  public digest(): Digest {
    if (stryMutAct_9fa48("2995")) {
      {}
    } else {
      stryCov_9fa48("2995");
      return Digest.sha256(AuthorityPermit.encode(this));
    }
  }
  public assertConsumable(expected: AuthorityPermitExpectation, now: Date): void {
    if (stryMutAct_9fa48("2996")) {
      {}
    } else {
      stryCov_9fa48("2996");
      const time = validTime(now, stryMutAct_9fa48("2997") ? "" : (stryCov_9fa48("2997"), "Authority permit consumption time"));
      if (stryMutAct_9fa48("3000") ? false : stryMutAct_9fa48("2999") ? true : stryMutAct_9fa48("2998") ? this.expectation.equals(expected) : (stryCov_9fa48("2998", "2999", "3000"), !this.expectation.equals(expected))) {
        if (stryMutAct_9fa48("3001")) {
          {}
        } else {
          stryCov_9fa48("3001");
          throw denied(stryMutAct_9fa48("3002") ? "" : (stryCov_9fa48("3002"), "Authority permit does not match the exact target admission"));
        }
      }
      if (stryMutAct_9fa48("3005") ? this.#issuedAt > time && time >= this.#expiresAt : stryMutAct_9fa48("3004") ? false : stryMutAct_9fa48("3003") ? true : (stryCov_9fa48("3003", "3004", "3005"), (stryMutAct_9fa48("3008") ? this.#issuedAt <= time : stryMutAct_9fa48("3007") ? this.#issuedAt >= time : stryMutAct_9fa48("3006") ? false : (stryCov_9fa48("3006", "3007", "3008"), this.#issuedAt > time)) || (stryMutAct_9fa48("3011") ? time < this.#expiresAt : stryMutAct_9fa48("3010") ? time > this.#expiresAt : stryMutAct_9fa48("3009") ? false : (stryCov_9fa48("3009", "3010", "3011"), time >= this.#expiresAt)))) {
        if (stryMutAct_9fa48("3012")) {
          {}
        } else {
          stryCov_9fa48("3012");
          throw denied(stryMutAct_9fa48("3013") ? "" : (stryCov_9fa48("3013"), "Authority permit is not valid at the target admission time"));
        }
      }
    }
  }
  public toData(): JsonObject {
    if (stryMutAct_9fa48("3014")) {
      {}
    } else {
      stryCov_9fa48("3014");
      return stryMutAct_9fa48("3015") ? {} : (stryCov_9fa48("3015"), {
        ...this.expectation.toData(),
        expiresAt: this.#expiresAt,
        issuedAt: this.#issuedAt,
        nonce: this.nonce
      });
    }
  }
  public static fromData(value: JsonValue | undefined): AuthorityPermit {
    if (stryMutAct_9fa48("3016")) {
      {}
    } else {
      stryCov_9fa48("3016");
      const object = requireObject(value, stryMutAct_9fa48("3017") ? "" : (stryCov_9fa48("3017"), "Authority permit"));
      requireExact(object, stryMutAct_9fa48("3018") ? [] : (stryCov_9fa48("3018"), [...EXPECTATION_FIELDS, stryMutAct_9fa48("3019") ? "" : (stryCov_9fa48("3019"), "expiresAt"), stryMutAct_9fa48("3020") ? "" : (stryCov_9fa48("3020"), "issuedAt"), stryMutAct_9fa48("3021") ? "" : (stryCov_9fa48("3021"), "nonce")]), stryMutAct_9fa48("3022") ? "" : (stryCov_9fa48("3022"), "Authority permit"));
      const expectationData = Object.fromEntries(EXPECTATION_FIELDS.map(field => [field, object[field]!])) as JsonObject;
      const expectation = AuthorityPermitExpectation.fromData(expectationData);
      return new AuthorityPermit(stryMutAct_9fa48("3023") ? {} : (stryCov_9fa48("3023"), {
        ...expectation,
        nonce: requireString(object, stryMutAct_9fa48("3024") ? "" : (stryCov_9fa48("3024"), "nonce")),
        issuedAt: new Date(requireSafeInteger(object, stryMutAct_9fa48("3025") ? "" : (stryCov_9fa48("3025"), "issuedAt"))),
        expiresAt: new Date(requireSafeInteger(object, stryMutAct_9fa48("3026") ? "" : (stryCov_9fa48("3026"), "expiresAt")))
      }));
    }
  }
}
function copyTarget(target: AuthorityPermitTarget): AuthorityPermitTarget {
  if (stryMutAct_9fa48("3027")) {
    {}
  } else {
    stryCov_9fa48("3027");
    return Object.freeze(stryMutAct_9fa48("3028") ? {} : (stryCov_9fa48("3028"), {
      actor: copyActor(target.actor),
      fence: target.fence,
      domain: decodeDomain(encodeDomain(target.domain))
    }));
  }
}
function copyReservation(reservation: AuthorityPermitReservation): AuthorityPermitReservation {
  if (stryMutAct_9fa48("3029")) {
    {}
  } else {
    stryCov_9fa48("3029");
    requireNonblank(reservation.obligation.itemKey, stryMutAct_9fa48("3030") ? "" : (stryCov_9fa48("3030"), "Authority permit reservation item key"));
    requireIndex(reservation.obligation.itemIndex, stryMutAct_9fa48("3031") ? "" : (stryCov_9fa48("3031"), "Authority permit reservation item index"));
    return Object.freeze(stryMutAct_9fa48("3032") ? {} : (stryCov_9fa48("3032"), {
      run: reservation.run,
      registryEpoch: reservation.registryEpoch,
      obligation: Object.freeze(stryMutAct_9fa48("3033") ? {} : (stryCov_9fa48("3033"), {
        kind: "invocationItem" as const,
        invocation: reservation.obligation.invocation,
        itemIndex: reservation.obligation.itemIndex,
        itemKey: reservation.obligation.itemKey
      }))
    }));
  }
}
function encodeReservation(reservation: AuthorityPermitReservation): JsonObject {
  if (stryMutAct_9fa48("3034")) {
    {}
  } else {
    stryCov_9fa48("3034");
    return stryMutAct_9fa48("3035") ? {} : (stryCov_9fa48("3035"), {
      obligation: stryMutAct_9fa48("3036") ? {} : (stryCov_9fa48("3036"), {
        invocation: reservation.obligation.invocation.value,
        itemIndex: reservation.obligation.itemIndex,
        itemKey: reservation.obligation.itemKey,
        kind: reservation.obligation.kind
      }),
      registryEpoch: reservation.registryEpoch,
      run: reservation.run.value
    });
  }
}
function decodeReservation(value: JsonValue | undefined): AuthorityPermitReservation {
  if (stryMutAct_9fa48("3037")) {
    {}
  } else {
    stryCov_9fa48("3037");
    const object = requireObject(value, stryMutAct_9fa48("3038") ? "" : (stryCov_9fa48("3038"), "Authority permit reservation"));
    const obligation = requireObject(object[stryMutAct_9fa48("3039") ? "" : (stryCov_9fa48("3039"), "obligation")], stryMutAct_9fa48("3040") ? "" : (stryCov_9fa48("3040"), "Authority permit obligation"));
    requireExact(object, stryMutAct_9fa48("3041") ? [] : (stryCov_9fa48("3041"), [stryMutAct_9fa48("3042") ? "" : (stryCov_9fa48("3042"), "obligation"), stryMutAct_9fa48("3043") ? "" : (stryCov_9fa48("3043"), "registryEpoch"), stryMutAct_9fa48("3044") ? "" : (stryCov_9fa48("3044"), "run")]), stryMutAct_9fa48("3045") ? "" : (stryCov_9fa48("3045"), "Authority permit reservation"));
    requireExact(obligation, stryMutAct_9fa48("3046") ? [] : (stryCov_9fa48("3046"), [stryMutAct_9fa48("3047") ? "" : (stryCov_9fa48("3047"), "invocation"), stryMutAct_9fa48("3048") ? "" : (stryCov_9fa48("3048"), "itemIndex"), stryMutAct_9fa48("3049") ? "" : (stryCov_9fa48("3049"), "itemKey"), stryMutAct_9fa48("3050") ? "" : (stryCov_9fa48("3050"), "kind")]), stryMutAct_9fa48("3051") ? "" : (stryCov_9fa48("3051"), "Authority permit obligation"));
    if (stryMutAct_9fa48("3054") ? obligation["kind"] === "invocationItem" : stryMutAct_9fa48("3053") ? false : stryMutAct_9fa48("3052") ? true : (stryCov_9fa48("3052", "3053", "3054"), obligation[stryMutAct_9fa48("3055") ? "" : (stryCov_9fa48("3055"), "kind")] !== (stryMutAct_9fa48("3056") ? "" : (stryCov_9fa48("3056"), "invocationItem")))) {
      if (stryMutAct_9fa48("3057")) {
        {}
      } else {
        stryCov_9fa48("3057");
        throw new TypeError(stryMutAct_9fa48("3058") ? "" : (stryCov_9fa48("3058"), "Authority permit requires an invocation-item reservation"));
      }
    }
    return Object.freeze(stryMutAct_9fa48("3059") ? {} : (stryCov_9fa48("3059"), {
      run: new RunId(requireString(object, stryMutAct_9fa48("3060") ? "" : (stryCov_9fa48("3060"), "run"))),
      registryEpoch: requireSafeInteger(object, stryMutAct_9fa48("3061") ? "" : (stryCov_9fa48("3061"), "registryEpoch")),
      obligation: Object.freeze(stryMutAct_9fa48("3062") ? {} : (stryCov_9fa48("3062"), {
        kind: "invocationItem" as const,
        invocation: new InvocationId(requireString(obligation, stryMutAct_9fa48("3063") ? "" : (stryCov_9fa48("3063"), "invocation"))),
        itemIndex: requireSafeInteger(obligation, stryMutAct_9fa48("3064") ? "" : (stryCov_9fa48("3064"), "itemIndex")),
        itemKey: requireString(obligation, stryMutAct_9fa48("3065") ? "" : (stryCov_9fa48("3065"), "itemKey"))
      }))
    }));
  }
}
function copyClaimOwner(owner: AuthorityPermitClaimOwner): AuthorityPermitClaimOwner {
  if (stryMutAct_9fa48("3066")) {
    {}
  } else {
    stryCov_9fa48("3066");
    return (stryMutAct_9fa48("3069") ? owner.kind !== "executor" : stryMutAct_9fa48("3068") ? false : stryMutAct_9fa48("3067") ? true : (stryCov_9fa48("3067", "3068", "3069"), owner.kind === (stryMutAct_9fa48("3070") ? "" : (stryCov_9fa48("3070"), "executor")))) ? Object.freeze(stryMutAct_9fa48("3071") ? {} : (stryCov_9fa48("3071"), {
      kind: owner.kind,
      token: copyLease(owner.token),
      worker: owner.worker
    })) : Object.freeze(stryMutAct_9fa48("3072") ? {} : (stryCov_9fa48("3072"), {
      kind: owner.kind,
      actor: copyActor(owner.actor),
      worker: owner.worker
    }));
  }
}
function encodeClaimOwner(owner: AuthorityPermitClaimOwner): JsonObject {
  if (stryMutAct_9fa48("3073")) {
    {}
  } else {
    stryCov_9fa48("3073");
    return (stryMutAct_9fa48("3076") ? owner.kind !== "executor" : stryMutAct_9fa48("3075") ? false : stryMutAct_9fa48("3074") ? true : (stryCov_9fa48("3074", "3075", "3076"), owner.kind === (stryMutAct_9fa48("3077") ? "" : (stryCov_9fa48("3077"), "executor")))) ? stryMutAct_9fa48("3078") ? {} : (stryCov_9fa48("3078"), {
      kind: owner.kind,
      token: encodeLease(owner.token),
      worker: owner.worker.value
    }) : stryMutAct_9fa48("3079") ? {} : (stryCov_9fa48("3079"), {
      actor: encodeActor(owner.actor),
      kind: owner.kind,
      worker: owner.worker.value
    });
  }
}
function decodeClaimOwner(value: JsonValue | undefined): AuthorityPermitClaimOwner {
  if (stryMutAct_9fa48("3080")) {
    {}
  } else {
    stryCov_9fa48("3080");
    const object = requireObject(value, stryMutAct_9fa48("3081") ? "" : (stryCov_9fa48("3081"), "Authority permit claim owner"));
    const kind = requireString(object, stryMutAct_9fa48("3082") ? "" : (stryCov_9fa48("3082"), "kind"));
    if (stryMutAct_9fa48("3085") ? kind !== "executor" : stryMutAct_9fa48("3084") ? false : stryMutAct_9fa48("3083") ? true : (stryCov_9fa48("3083", "3084", "3085"), kind === (stryMutAct_9fa48("3086") ? "" : (stryCov_9fa48("3086"), "executor")))) {
      if (stryMutAct_9fa48("3087")) {
        {}
      } else {
        stryCov_9fa48("3087");
        requireExact(object, stryMutAct_9fa48("3088") ? [] : (stryCov_9fa48("3088"), [stryMutAct_9fa48("3089") ? "" : (stryCov_9fa48("3089"), "kind"), stryMutAct_9fa48("3090") ? "" : (stryCov_9fa48("3090"), "token"), stryMutAct_9fa48("3091") ? "" : (stryCov_9fa48("3091"), "worker")]), stryMutAct_9fa48("3092") ? "" : (stryCov_9fa48("3092"), "Authority permit claim owner"));
        return Object.freeze(stryMutAct_9fa48("3093") ? {} : (stryCov_9fa48("3093"), {
          kind,
          token: decodeLease(object[stryMutAct_9fa48("3094") ? "" : (stryCov_9fa48("3094"), "token")]),
          worker: new ClaimWorkerId(requireString(object, stryMutAct_9fa48("3095") ? "" : (stryCov_9fa48("3095"), "worker")))
        }));
      }
    }
    if (stryMutAct_9fa48("3098") ? kind !== "system" : stryMutAct_9fa48("3097") ? false : stryMutAct_9fa48("3096") ? true : (stryCov_9fa48("3096", "3097", "3098"), kind === (stryMutAct_9fa48("3099") ? "" : (stryCov_9fa48("3099"), "system")))) {
      if (stryMutAct_9fa48("3100")) {
        {}
      } else {
        stryCov_9fa48("3100");
        requireExact(object, stryMutAct_9fa48("3101") ? [] : (stryCov_9fa48("3101"), [stryMutAct_9fa48("3102") ? "" : (stryCov_9fa48("3102"), "actor"), stryMutAct_9fa48("3103") ? "" : (stryCov_9fa48("3103"), "kind"), stryMutAct_9fa48("3104") ? "" : (stryCov_9fa48("3104"), "worker")]), stryMutAct_9fa48("3105") ? "" : (stryCov_9fa48("3105"), "Authority permit claim owner"));
        return Object.freeze(stryMutAct_9fa48("3106") ? {} : (stryCov_9fa48("3106"), {
          kind,
          actor: decodeActor(object[stryMutAct_9fa48("3107") ? "" : (stryCov_9fa48("3107"), "actor")]),
          worker: new ClaimWorkerId(requireString(object, stryMutAct_9fa48("3108") ? "" : (stryCov_9fa48("3108"), "worker")))
        }));
      }
    }
    throw new TypeError(stryMutAct_9fa48("3109") ? "" : (stryCov_9fa48("3109"), "Authority permit claim owner kind is invalid"));
  }
}
function copyAuthority(authority: AuthorityPermitSource): AuthorityPermitSource {
  if (stryMutAct_9fa48("3110")) {
    {}
  } else {
    stryCov_9fa48("3110");
    return Object.freeze(stryMutAct_9fa48("3111") ? {} : (stryCov_9fa48("3111"), {
      kind: authority.kind,
      principal: new PrincipalRef(authority.principal.tenantId, authority.principal.principalId),
      binding: authority.binding
    }));
  }
}
function encodeAuthority(authority: AuthorityPermitSource): JsonObject {
  if (stryMutAct_9fa48("3112")) {
    {}
  } else {
    stryCov_9fa48("3112");
    return stryMutAct_9fa48("3113") ? {} : (stryCov_9fa48("3113"), {
      binding: authority.binding.value,
      kind: authority.kind,
      principal: encodePrincipal(authority.principal)
    });
  }
}
function decodeAuthority(value: JsonValue | undefined): AuthorityPermitSource {
  if (stryMutAct_9fa48("3114")) {
    {}
  } else {
    stryCov_9fa48("3114");
    const object = requireObject(value, stryMutAct_9fa48("3115") ? "" : (stryCov_9fa48("3115"), "Authority permit source"));
    requireExact(object, stryMutAct_9fa48("3116") ? [] : (stryCov_9fa48("3116"), [stryMutAct_9fa48("3117") ? "" : (stryCov_9fa48("3117"), "binding"), stryMutAct_9fa48("3118") ? "" : (stryCov_9fa48("3118"), "kind"), stryMutAct_9fa48("3119") ? "" : (stryCov_9fa48("3119"), "principal")]), stryMutAct_9fa48("3120") ? "" : (stryCov_9fa48("3120"), "Authority permit source"));
    const kind = object[stryMutAct_9fa48("3121") ? "" : (stryCov_9fa48("3121"), "kind")];
    if (stryMutAct_9fa48("3124") ? kind !== "initiator" || kind !== "delegated" : stryMutAct_9fa48("3123") ? false : stryMutAct_9fa48("3122") ? true : (stryCov_9fa48("3122", "3123", "3124"), (stryMutAct_9fa48("3126") ? kind === "initiator" : stryMutAct_9fa48("3125") ? true : (stryCov_9fa48("3125", "3126"), kind !== (stryMutAct_9fa48("3127") ? "" : (stryCov_9fa48("3127"), "initiator")))) && (stryMutAct_9fa48("3129") ? kind === "delegated" : stryMutAct_9fa48("3128") ? true : (stryCov_9fa48("3128", "3129"), kind !== (stryMutAct_9fa48("3130") ? "" : (stryCov_9fa48("3130"), "delegated")))))) {
      if (stryMutAct_9fa48("3131")) {
        {}
      } else {
        stryCov_9fa48("3131");
        throw new TypeError(stryMutAct_9fa48("3132") ? "" : (stryCov_9fa48("3132"), "Authority permit source kind is invalid"));
      }
    }
    return Object.freeze(stryMutAct_9fa48("3133") ? {} : (stryCov_9fa48("3133"), {
      kind,
      principal: decodePrincipal(object[stryMutAct_9fa48("3134") ? "" : (stryCov_9fa48("3134"), "principal")]),
      binding: new BindingName(requireString(object, stryMutAct_9fa48("3135") ? "" : (stryCov_9fa48("3135"), "binding")))
    }));
  }
}
function encodePrincipal(principal: PrincipalRef): JsonObject {
  if (stryMutAct_9fa48("3136")) {
    {}
  } else {
    stryCov_9fa48("3136");
    return stryMutAct_9fa48("3137") ? {} : (stryCov_9fa48("3137"), {
      principal: principal.principalId.value,
      tenant: principal.tenantId.value
    });
  }
}
function decodePrincipal(value: JsonValue | undefined): PrincipalRef {
  if (stryMutAct_9fa48("3138")) {
    {}
  } else {
    stryCov_9fa48("3138");
    const object = requireObject(value, stryMutAct_9fa48("3139") ? "" : (stryCov_9fa48("3139"), "Authority permit principal"));
    requireExact(object, stryMutAct_9fa48("3140") ? [] : (stryCov_9fa48("3140"), [stryMutAct_9fa48("3141") ? "" : (stryCov_9fa48("3141"), "principal"), stryMutAct_9fa48("3142") ? "" : (stryCov_9fa48("3142"), "tenant")]), stryMutAct_9fa48("3143") ? "" : (stryCov_9fa48("3143"), "Authority permit principal"));
    return new PrincipalRef(new TenantId(requireString(object, stryMutAct_9fa48("3144") ? "" : (stryCov_9fa48("3144"), "tenant"))), new PrincipalId(requireString(object, stryMutAct_9fa48("3145") ? "" : (stryCov_9fa48("3145"), "principal"))));
  }
}
function copyLease(lease: LeaseToken): LeaseToken {
  if (stryMutAct_9fa48("3146")) {
    {}
  } else {
    stryCov_9fa48("3146");
    requireIndex(lease.epoch, stryMutAct_9fa48("3147") ? "" : (stryCov_9fa48("3147"), "Authority permit lease epoch"));
    return Object.freeze(stryMutAct_9fa48("3148") ? {} : (stryCov_9fa48("3148"), {
      turn: lease.turn,
      holder: lease.holder,
      epoch: lease.epoch
    }));
  }
}
function encodeLease(lease: LeaseToken): JsonObject {
  if (stryMutAct_9fa48("3149")) {
    {}
  } else {
    stryCov_9fa48("3149");
    return stryMutAct_9fa48("3150") ? {} : (stryCov_9fa48("3150"), {
      epoch: lease.epoch,
      holder: lease.holder.value,
      turn: lease.turn.value
    });
  }
}
function decodeLease(value: JsonValue | undefined): LeaseToken {
  if (stryMutAct_9fa48("3151")) {
    {}
  } else {
    stryCov_9fa48("3151");
    const object = requireObject(value, stryMutAct_9fa48("3152") ? "" : (stryCov_9fa48("3152"), "Authority permit lease"));
    requireExact(object, stryMutAct_9fa48("3153") ? [] : (stryCov_9fa48("3153"), [stryMutAct_9fa48("3154") ? "" : (stryCov_9fa48("3154"), "epoch"), stryMutAct_9fa48("3155") ? "" : (stryCov_9fa48("3155"), "holder"), stryMutAct_9fa48("3156") ? "" : (stryCov_9fa48("3156"), "turn")]), stryMutAct_9fa48("3157") ? "" : (stryCov_9fa48("3157"), "Authority permit lease"));
    return Object.freeze(stryMutAct_9fa48("3158") ? {} : (stryCov_9fa48("3158"), {
      turn: new TurnId(requireString(object, stryMutAct_9fa48("3159") ? "" : (stryCov_9fa48("3159"), "turn"))),
      holder: new PrincipalId(requireString(object, stryMutAct_9fa48("3160") ? "" : (stryCov_9fa48("3160"), "holder"))),
      epoch: requireSafeInteger(object, stryMutAct_9fa48("3161") ? "" : (stryCov_9fa48("3161"), "epoch"))
    }));
  }
}
function encodeActor(actor: ActorRef): JsonObject {
  if (stryMutAct_9fa48("3162")) {
    {}
  } else {
    stryCov_9fa48("3162");
    return stryMutAct_9fa48("3163") ? {} : (stryCov_9fa48("3163"), {
      id: actor.id.value,
      kind: actor.kind
    });
  }
}
function copyActor(actor: ActorRef): ActorRef {
  if (stryMutAct_9fa48("3164")) {
    {}
  } else {
    stryCov_9fa48("3164");
    return new ActorRef(actor.kind, new ActorId(actor.id.value));
  }
}
function decodeActor(value: JsonValue | undefined): ActorRef {
  if (stryMutAct_9fa48("3165")) {
    {}
  } else {
    stryCov_9fa48("3165");
    const object = requireObject(value, stryMutAct_9fa48("3166") ? "" : (stryCov_9fa48("3166"), "Authority permit Actor"));
    requireExact(object, stryMutAct_9fa48("3167") ? [] : (stryCov_9fa48("3167"), [stryMutAct_9fa48("3168") ? "" : (stryCov_9fa48("3168"), "id"), stryMutAct_9fa48("3169") ? "" : (stryCov_9fa48("3169"), "kind")]), stryMutAct_9fa48("3170") ? "" : (stryCov_9fa48("3170"), "Authority permit Actor"));
    return new ActorRef(requireActorKind(object[stryMutAct_9fa48("3171") ? "" : (stryCov_9fa48("3171"), "kind")]), new ActorId(requireString(object, stryMutAct_9fa48("3172") ? "" : (stryCov_9fa48("3172"), "id"))));
  }
}
function requireActorKind(value: JsonValue | undefined): ActorKind {
  if (stryMutAct_9fa48("3173")) {
    {}
  } else {
    stryCov_9fa48("3173");
    if (stryMutAct_9fa48("3176") ? (value === "tenant" || value === "workspace" || value === "run" || value === "environment") && value === "slate" : stryMutAct_9fa48("3175") ? false : stryMutAct_9fa48("3174") ? true : (stryCov_9fa48("3174", "3175", "3176"), (stryMutAct_9fa48("3178") ? (value === "tenant" || value === "workspace" || value === "run") && value === "environment" : stryMutAct_9fa48("3177") ? false : (stryCov_9fa48("3177", "3178"), (stryMutAct_9fa48("3180") ? (value === "tenant" || value === "workspace") && value === "run" : stryMutAct_9fa48("3179") ? false : (stryCov_9fa48("3179", "3180"), (stryMutAct_9fa48("3182") ? value === "tenant" && value === "workspace" : stryMutAct_9fa48("3181") ? false : (stryCov_9fa48("3181", "3182"), (stryMutAct_9fa48("3184") ? value !== "tenant" : stryMutAct_9fa48("3183") ? false : (stryCov_9fa48("3183", "3184"), value === (stryMutAct_9fa48("3185") ? "" : (stryCov_9fa48("3185"), "tenant")))) || (stryMutAct_9fa48("3187") ? value !== "workspace" : stryMutAct_9fa48("3186") ? false : (stryCov_9fa48("3186", "3187"), value === (stryMutAct_9fa48("3188") ? "" : (stryCov_9fa48("3188"), "workspace")))))) || (stryMutAct_9fa48("3190") ? value !== "run" : stryMutAct_9fa48("3189") ? false : (stryCov_9fa48("3189", "3190"), value === (stryMutAct_9fa48("3191") ? "" : (stryCov_9fa48("3191"), "run")))))) || (stryMutAct_9fa48("3193") ? value !== "environment" : stryMutAct_9fa48("3192") ? false : (stryCov_9fa48("3192", "3193"), value === (stryMutAct_9fa48("3194") ? "" : (stryCov_9fa48("3194"), "environment")))))) || (stryMutAct_9fa48("3196") ? value !== "slate" : stryMutAct_9fa48("3195") ? false : (stryCov_9fa48("3195", "3196"), value === (stryMutAct_9fa48("3197") ? "" : (stryCov_9fa48("3197"), "slate")))))) return value;
    throw new TypeError(stryMutAct_9fa48("3198") ? "" : (stryCov_9fa48("3198"), "Authority permit Actor kind is invalid"));
  }
}
function requireImpact(value: JsonValue | undefined): Impact {
  if (stryMutAct_9fa48("3199")) {
    {}
  } else {
    stryCov_9fa48("3199");
    if (stryMutAct_9fa48("3202") ? typeof value === "string" || POLICY_IMPACTS.includes(value as Impact) : stryMutAct_9fa48("3201") ? false : stryMutAct_9fa48("3200") ? true : (stryCov_9fa48("3200", "3201", "3202"), (stryMutAct_9fa48("3204") ? typeof value !== "string" : stryMutAct_9fa48("3203") ? true : (stryCov_9fa48("3203", "3204"), typeof value === (stryMutAct_9fa48("3205") ? "" : (stryCov_9fa48("3205"), "string")))) && POLICY_IMPACTS.includes(value as Impact))) {
      if (stryMutAct_9fa48("3206")) {
        {}
      } else {
        stryCov_9fa48("3206");
        return value as Impact;
      }
    }
    throw new TypeError(stryMutAct_9fa48("3207") ? "" : (stryCov_9fa48("3207"), "Authority permit impact is invalid"));
  }
}
function requireIndex(value: number, subject: string): void {
  if (stryMutAct_9fa48("3208")) {
    {}
  } else {
    stryCov_9fa48("3208");
    if (stryMutAct_9fa48("3211") ? !Number.isSafeInteger(value) && value < 0 : stryMutAct_9fa48("3210") ? false : stryMutAct_9fa48("3209") ? true : (stryCov_9fa48("3209", "3210", "3211"), (stryMutAct_9fa48("3212") ? Number.isSafeInteger(value) : (stryCov_9fa48("3212"), !Number.isSafeInteger(value))) || (stryMutAct_9fa48("3215") ? value >= 0 : stryMutAct_9fa48("3214") ? value <= 0 : stryMutAct_9fa48("3213") ? false : (stryCov_9fa48("3213", "3214", "3215"), value < 0)))) {
      if (stryMutAct_9fa48("3216")) {
        {}
      } else {
        stryCov_9fa48("3216");
        throw new TypeError(stryMutAct_9fa48("3217") ? `` : (stryCov_9fa48("3217"), `${subject} must be a non-negative safe integer`));
      }
    }
  }
}
function requireNonblank(value: string, subject: string): string {
  if (stryMutAct_9fa48("3218")) {
    {}
  } else {
    stryCov_9fa48("3218");
    if (stryMutAct_9fa48("3221") ? value.trim().length === 0 && value !== value.trim() : stryMutAct_9fa48("3220") ? false : stryMutAct_9fa48("3219") ? true : (stryCov_9fa48("3219", "3220", "3221"), (stryMutAct_9fa48("3223") ? value.trim().length !== 0 : stryMutAct_9fa48("3222") ? false : (stryCov_9fa48("3222", "3223"), (stryMutAct_9fa48("3224") ? value.length : (stryCov_9fa48("3224"), value.trim().length)) === 0)) || (stryMutAct_9fa48("3226") ? value === value.trim() : stryMutAct_9fa48("3225") ? false : (stryCov_9fa48("3225", "3226"), value !== (stryMutAct_9fa48("3227") ? value : (stryCov_9fa48("3227"), value.trim())))))) {
      if (stryMutAct_9fa48("3228")) {
        {}
      } else {
        stryCov_9fa48("3228");
        throw new TypeError(stryMutAct_9fa48("3229") ? `` : (stryCov_9fa48("3229"), `${subject} must be a nonblank canonical string`));
      }
    }
    return value;
  }
}
function validTime(value: Date, subject: string): number {
  if (stryMutAct_9fa48("3230")) {
    {}
  } else {
    stryCov_9fa48("3230");
    const time = value.getTime();
    if (stryMutAct_9fa48("3233") ? !Number.isSafeInteger(time) && time < 0 : stryMutAct_9fa48("3232") ? false : stryMutAct_9fa48("3231") ? true : (stryCov_9fa48("3231", "3232", "3233"), (stryMutAct_9fa48("3234") ? Number.isSafeInteger(time) : (stryCov_9fa48("3234"), !Number.isSafeInteger(time))) || (stryMutAct_9fa48("3237") ? time >= 0 : stryMutAct_9fa48("3236") ? time <= 0 : stryMutAct_9fa48("3235") ? false : (stryCov_9fa48("3235", "3236", "3237"), time < 0)))) {
      if (stryMutAct_9fa48("3238")) {
        {}
      } else {
        stryCov_9fa48("3238");
        throw new TypeError(stryMutAct_9fa48("3239") ? `` : (stryCov_9fa48("3239"), `${subject} must be a valid non-negative Date`));
      }
    }
    return time;
  }
}
function denied(message: string): AgentCoreError {
  if (stryMutAct_9fa48("3240")) {
    {}
  } else {
    stryCov_9fa48("3240");
    return new AgentCoreError(stryMutAct_9fa48("3241") ? "" : (stryCov_9fa48("3241"), "authority.denied"), message);
  }
}