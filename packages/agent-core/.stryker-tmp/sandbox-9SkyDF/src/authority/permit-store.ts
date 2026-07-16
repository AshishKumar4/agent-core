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
import { requireSynchronousResult, type ActorRef, type SynchronousResultGuard } from "../actors";
import { Digest } from "../core";
import { AgentCoreError } from "../errors";
import { AuthorityPermit, AuthorityPermitExpectation } from "./permit";
export interface AuthorityPermitOwnerStore<Transaction> {
  transaction<Result>(operation: (transaction: Transaction) => Result, ...guard: SynchronousResultGuard<Result>): Result;
  issued(transaction: Transaction, nonce: string): AuthorityPermit | undefined;
  consumed(transaction: Transaction, nonce: string): Digest | undefined;
  issue(transaction: Transaction, permit: AuthorityPermit): AuthorityPermit;
  consume(transaction: Transaction, permit: AuthorityPermit, expected: AuthorityPermitExpectation, now: Date): void;
}
export abstract class AuthorityPermitAuthorityPort<Transaction> {
  public abstract admits(transaction: Transaction, expectation: AuthorityPermitExpectation, issuedAt: Date): boolean;
}
export class AuthorityPermitIssuer<Transaction> {
  public constructor(private readonly store: AuthorityPermitOwnerStore<Transaction>, private readonly authority: AuthorityPermitAuthorityPort<Transaction>) {}
  public issue(transaction: Transaction, expectation: AuthorityPermitExpectation, nonce: string, issuedAt: Date, expiresAt: Date): AuthorityPermit {
    if (stryMutAct_9fa48("2661")) {
      {}
    } else {
      stryCov_9fa48("2661");
      const candidate = new AuthorityPermit(stryMutAct_9fa48("2662") ? {} : (stryCov_9fa48("2662"), {
        ...expectation,
        nonce,
        issuedAt,
        expiresAt
      }));
      const existing = this.store.issued(transaction, candidate.nonce);
      if (stryMutAct_9fa48("2665") ? existing === undefined : stryMutAct_9fa48("2664") ? false : stryMutAct_9fa48("2663") ? true : (stryCov_9fa48("2663", "2664", "2665"), existing !== undefined)) {
        if (stryMutAct_9fa48("2666")) {
          {}
        } else {
          stryCov_9fa48("2666");
          if (stryMutAct_9fa48("2669") ? false : stryMutAct_9fa48("2668") ? true : stryMutAct_9fa48("2667") ? existing.expectation.equals(candidate.expectation) : (stryCov_9fa48("2667", "2668", "2669"), !existing.expectation.equals(candidate.expectation))) {
            if (stryMutAct_9fa48("2670")) {
              {}
            } else {
              stryCov_9fa48("2670");
              throw denied(stryMutAct_9fa48("2671") ? "" : (stryCov_9fa48("2671"), "Authority permit nonce is bound to another issuance expectation"));
            }
          }
          return existing;
        }
      }
      if (stryMutAct_9fa48("2674") ? false : stryMutAct_9fa48("2673") ? true : stryMutAct_9fa48("2672") ? this.authority.admits(transaction, expectation, issuedAt) : (stryCov_9fa48("2672", "2673", "2674"), !this.authority.admits(transaction, expectation, issuedAt))) {
        if (stryMutAct_9fa48("2675")) {
          {}
        } else {
          stryCov_9fa48("2675");
          throw denied(stryMutAct_9fa48("2676") ? "" : (stryCov_9fa48("2676"), "Current Tenant authority does not admit permit issuance"));
        }
      }
      return this.store.issue(transaction, candidate);
    }
  }
}
export abstract class AuthorityPermitAdmissionPort<Transaction> {
  public abstract consume(transaction: Transaction, permit: AuthorityPermit, expected: AuthorityPermitExpectation, now: Date): void;
}
export class StoredAuthorityPermitAdmissionPort<Transaction> extends AuthorityPermitAdmissionPort<Transaction> {
  public constructor(private readonly store: AuthorityPermitOwnerStore<Transaction>) {
    super();
  }
  public consume(transaction: Transaction, permit: AuthorityPermit, expected: AuthorityPermitExpectation, now: Date): void {
    if (stryMutAct_9fa48("2677")) {
      {}
    } else {
      stryCov_9fa48("2677");
      this.store.consume(transaction, permit, expected, now);
    }
  }
}
export interface MemoryAuthorityPermitSnapshot {
  readonly version: 1;
  readonly issued: readonly {
    readonly nonce: string;
    readonly bytes: Uint8Array;
  }[];
  readonly consumed: readonly {
    readonly nonce: string;
    readonly digest: string;
  }[];
}
export class MemoryAuthorityPermitTransaction {
  public constructor(readonly ownerToken: object, readonly issuedRecords: Map<string, Uint8Array>, readonly consumedRecords: Map<string, string>) {}
}
export class MemoryAuthorityPermitStore implements AuthorityPermitOwnerStore<MemoryAuthorityPermitTransaction> {
  readonly #ownerToken = Object.freeze({});
  #issued = new Map<string, Uint8Array>();
  #consumed = new Map<string, string>();
  public constructor(public readonly owner: ActorRef, snapshot?: MemoryAuthorityPermitSnapshot) {
    if (stryMutAct_9fa48("2678")) {
      {}
    } else {
      stryCov_9fa48("2678");
      if (stryMutAct_9fa48("2681") ? snapshot === undefined : stryMutAct_9fa48("2680") ? false : stryMutAct_9fa48("2679") ? true : (stryCov_9fa48("2679", "2680", "2681"), snapshot !== undefined)) this.restore(snapshot);
    }
  }
  public transaction<Result>(operation: (transaction: MemoryAuthorityPermitTransaction) => Result, ..._guard: SynchronousResultGuard<Result>): Result {
    if (stryMutAct_9fa48("2682")) {
      {}
    } else {
      stryCov_9fa48("2682");
      const transaction = new MemoryAuthorityPermitTransaction(this.#ownerToken, cloneBytesMap(this.#issued), new Map(this.#consumed));
      const result = requireSynchronousResult(operation(transaction));
      this.#issued = transaction.issuedRecords;
      this.#consumed = transaction.consumedRecords;
      return result;
    }
  }
  public issued(transaction: MemoryAuthorityPermitTransaction, nonce: string): AuthorityPermit | undefined {
    if (stryMutAct_9fa48("2683")) {
      {}
    } else {
      stryCov_9fa48("2683");
      this.requireTransaction(transaction);
      const bytes = transaction.issuedRecords.get(nonce);
      if (stryMutAct_9fa48("2686") ? bytes !== undefined : stryMutAct_9fa48("2685") ? false : stryMutAct_9fa48("2684") ? true : (stryCov_9fa48("2684", "2685", "2686"), bytes === undefined)) return undefined;
      const permit = AuthorityPermit.decode(stryMutAct_9fa48("2687") ? bytes : (stryCov_9fa48("2687"), bytes.slice()));
      this.assertIssuedOwner(permit);
      if (stryMutAct_9fa48("2690") ? permit.nonce === nonce : stryMutAct_9fa48("2689") ? false : stryMutAct_9fa48("2688") ? true : (stryCov_9fa48("2688", "2689", "2690"), permit.nonce !== nonce)) throw corrupt();
      return permit;
    }
  }
  public consumed(transaction: MemoryAuthorityPermitTransaction, nonce: string): Digest | undefined {
    if (stryMutAct_9fa48("2691")) {
      {}
    } else {
      stryCov_9fa48("2691");
      this.requireTransaction(transaction);
      const digest = transaction.consumedRecords.get(nonce);
      return (stryMutAct_9fa48("2694") ? digest !== undefined : stryMutAct_9fa48("2693") ? false : stryMutAct_9fa48("2692") ? true : (stryCov_9fa48("2692", "2693", "2694"), digest === undefined)) ? undefined : new Digest(digest);
    }
  }
  public issue(transaction: MemoryAuthorityPermitTransaction, permit: AuthorityPermit): AuthorityPermit {
    if (stryMutAct_9fa48("2695")) {
      {}
    } else {
      stryCov_9fa48("2695");
      this.requireTransaction(transaction);
      this.assertIssuedOwner(permit);
      const existing = this.issued(transaction, permit.nonce);
      if (stryMutAct_9fa48("2698") ? existing === undefined : stryMutAct_9fa48("2697") ? false : stryMutAct_9fa48("2696") ? true : (stryCov_9fa48("2696", "2697", "2698"), existing !== undefined)) {
        if (stryMutAct_9fa48("2699")) {
          {}
        } else {
          stryCov_9fa48("2699");
          if (stryMutAct_9fa48("2702") ? false : stryMutAct_9fa48("2701") ? true : stryMutAct_9fa48("2700") ? existing.expectation.equals(permit.expectation) : (stryCov_9fa48("2700", "2701", "2702"), !existing.expectation.equals(permit.expectation))) {
            if (stryMutAct_9fa48("2703")) {
              {}
            } else {
              stryCov_9fa48("2703");
              throw denied(stryMutAct_9fa48("2704") ? "" : (stryCov_9fa48("2704"), "Authority permit nonce is bound to another issuance expectation"));
            }
          }
          return existing;
        }
      }
      if (stryMutAct_9fa48("2706") ? false : stryMutAct_9fa48("2705") ? true : (stryCov_9fa48("2705", "2706"), transaction.consumedRecords.has(permit.nonce))) {
        if (stryMutAct_9fa48("2707")) {
          {}
        } else {
          stryCov_9fa48("2707");
          throw denied(stryMutAct_9fa48("2708") ? "" : (stryCov_9fa48("2708"), "Authority permit nonce was already used by this Actor owner"));
        }
      }
      transaction.issuedRecords.set(permit.nonce, AuthorityPermit.encode(permit));
      return permit;
    }
  }
  public consume(transaction: MemoryAuthorityPermitTransaction, permit: AuthorityPermit, expected: AuthorityPermitExpectation, now: Date): void {
    if (stryMutAct_9fa48("2709")) {
      {}
    } else {
      stryCov_9fa48("2709");
      this.requireTransaction(transaction);
      if (stryMutAct_9fa48("2712") ? false : stryMutAct_9fa48("2711") ? true : stryMutAct_9fa48("2710") ? permit.target.actor.equals(this.owner) : (stryCov_9fa48("2710", "2711", "2712"), !permit.target.actor.equals(this.owner))) {
        if (stryMutAct_9fa48("2713")) {
          {}
        } else {
          stryCov_9fa48("2713");
          throw denied(stryMutAct_9fa48("2714") ? "" : (stryCov_9fa48("2714"), "Authority permit targets another Actor owner"));
        }
      }
      permit.assertConsumable(expected, now);
      this.requireUnused(transaction, permit.nonce);
      transaction.consumedRecords.set(permit.nonce, permit.digest().value);
    }
  }
  public snapshot(): MemoryAuthorityPermitSnapshot {
    if (stryMutAct_9fa48("2715")) {
      {}
    } else {
      stryCov_9fa48("2715");
      return stryMutAct_9fa48("2716") ? {} : (stryCov_9fa48("2716"), {
        version: 1,
        issued: Object.freeze(stryMutAct_9fa48("2717") ? [...this.#issued].map(([nonce, bytes]) => Object.freeze({
          nonce,
          bytes: bytes.slice()
        })) : (stryCov_9fa48("2717"), (stryMutAct_9fa48("2718") ? [] : (stryCov_9fa48("2718"), [...this.#issued])).sort(stryMutAct_9fa48("2719") ? () => undefined : (stryCov_9fa48("2719"), ([left], [right]) => left.localeCompare(right))).map(stryMutAct_9fa48("2720") ? () => undefined : (stryCov_9fa48("2720"), ([nonce, bytes]) => Object.freeze(stryMutAct_9fa48("2721") ? {} : (stryCov_9fa48("2721"), {
          nonce,
          bytes: stryMutAct_9fa48("2722") ? bytes : (stryCov_9fa48("2722"), bytes.slice())
        })))))),
        consumed: Object.freeze(stryMutAct_9fa48("2723") ? [...this.#consumed].map(([nonce, digest]) => Object.freeze({
          nonce,
          digest
        })) : (stryCov_9fa48("2723"), (stryMutAct_9fa48("2724") ? [] : (stryCov_9fa48("2724"), [...this.#consumed])).sort(stryMutAct_9fa48("2725") ? () => undefined : (stryCov_9fa48("2725"), ([left], [right]) => left.localeCompare(right))).map(stryMutAct_9fa48("2726") ? () => undefined : (stryCov_9fa48("2726"), ([nonce, digest]) => Object.freeze(stryMutAct_9fa48("2727") ? {} : (stryCov_9fa48("2727"), {
          nonce,
          digest
        }))))))
      });
    }
  }
  private restore(snapshot: MemoryAuthorityPermitSnapshot): void {
    if (stryMutAct_9fa48("2728")) {
      {}
    } else {
      stryCov_9fa48("2728");
      if (stryMutAct_9fa48("2731") ? (snapshot.version !== 1 || !Array.isArray(snapshot.issued)) && !Array.isArray(snapshot.consumed) : stryMutAct_9fa48("2730") ? false : stryMutAct_9fa48("2729") ? true : (stryCov_9fa48("2729", "2730", "2731"), (stryMutAct_9fa48("2733") ? snapshot.version !== 1 && !Array.isArray(snapshot.issued) : stryMutAct_9fa48("2732") ? false : (stryCov_9fa48("2732", "2733"), (stryMutAct_9fa48("2735") ? snapshot.version === 1 : stryMutAct_9fa48("2734") ? false : (stryCov_9fa48("2734", "2735"), snapshot.version !== 1)) || (stryMutAct_9fa48("2736") ? Array.isArray(snapshot.issued) : (stryCov_9fa48("2736"), !Array.isArray(snapshot.issued))))) || (stryMutAct_9fa48("2737") ? Array.isArray(snapshot.consumed) : (stryCov_9fa48("2737"), !Array.isArray(snapshot.consumed))))) throw corrupt();
      const transaction = new MemoryAuthorityPermitTransaction(this.#ownerToken, new Map(), new Map());
      for (const record of snapshot.issued) {
        if (stryMutAct_9fa48("2738")) {
          {}
        } else {
          stryCov_9fa48("2738");
          if (stryMutAct_9fa48("2741") ? (record === null || typeof record !== "object" || typeof record.nonce !== "string" || !(record.bytes instanceof Uint8Array)) && transaction.issuedRecords.has(record.nonce) : stryMutAct_9fa48("2740") ? false : stryMutAct_9fa48("2739") ? true : (stryCov_9fa48("2739", "2740", "2741"), (stryMutAct_9fa48("2743") ? (record === null || typeof record !== "object" || typeof record.nonce !== "string") && !(record.bytes instanceof Uint8Array) : stryMutAct_9fa48("2742") ? false : (stryCov_9fa48("2742", "2743"), (stryMutAct_9fa48("2745") ? (record === null || typeof record !== "object") && typeof record.nonce !== "string" : stryMutAct_9fa48("2744") ? false : (stryCov_9fa48("2744", "2745"), (stryMutAct_9fa48("2747") ? record === null && typeof record !== "object" : stryMutAct_9fa48("2746") ? false : (stryCov_9fa48("2746", "2747"), (stryMutAct_9fa48("2749") ? record !== null : stryMutAct_9fa48("2748") ? false : (stryCov_9fa48("2748", "2749"), record === null)) || (stryMutAct_9fa48("2751") ? typeof record === "object" : stryMutAct_9fa48("2750") ? false : (stryCov_9fa48("2750", "2751"), typeof record !== (stryMutAct_9fa48("2752") ? "" : (stryCov_9fa48("2752"), "object")))))) || (stryMutAct_9fa48("2754") ? typeof record.nonce === "string" : stryMutAct_9fa48("2753") ? false : (stryCov_9fa48("2753", "2754"), typeof record.nonce !== (stryMutAct_9fa48("2755") ? "" : (stryCov_9fa48("2755"), "string")))))) || (stryMutAct_9fa48("2756") ? record.bytes instanceof Uint8Array : (stryCov_9fa48("2756"), !(record.bytes instanceof Uint8Array))))) || transaction.issuedRecords.has(record.nonce))) throw corrupt();
          const permit = AuthorityPermit.decode(stryMutAct_9fa48("2757") ? record.bytes : (stryCov_9fa48("2757"), record.bytes.slice()));
          this.assertIssuedOwner(permit);
          if (stryMutAct_9fa48("2760") ? permit.nonce === record.nonce : stryMutAct_9fa48("2759") ? false : stryMutAct_9fa48("2758") ? true : (stryCov_9fa48("2758", "2759", "2760"), permit.nonce !== record.nonce)) throw corrupt();
          transaction.issuedRecords.set(record.nonce, AuthorityPermit.encode(permit));
        }
      }
      for (const record of snapshot.consumed) {
        if (stryMutAct_9fa48("2761")) {
          {}
        } else {
          stryCov_9fa48("2761");
          if (stryMutAct_9fa48("2764") ? (record === null || typeof record !== "object" || typeof record.nonce !== "string" || typeof record.digest !== "string") && transaction.consumedRecords.has(record.nonce) : stryMutAct_9fa48("2763") ? false : stryMutAct_9fa48("2762") ? true : (stryCov_9fa48("2762", "2763", "2764"), (stryMutAct_9fa48("2766") ? (record === null || typeof record !== "object" || typeof record.nonce !== "string") && typeof record.digest !== "string" : stryMutAct_9fa48("2765") ? false : (stryCov_9fa48("2765", "2766"), (stryMutAct_9fa48("2768") ? (record === null || typeof record !== "object") && typeof record.nonce !== "string" : stryMutAct_9fa48("2767") ? false : (stryCov_9fa48("2767", "2768"), (stryMutAct_9fa48("2770") ? record === null && typeof record !== "object" : stryMutAct_9fa48("2769") ? false : (stryCov_9fa48("2769", "2770"), (stryMutAct_9fa48("2772") ? record !== null : stryMutAct_9fa48("2771") ? false : (stryCov_9fa48("2771", "2772"), record === null)) || (stryMutAct_9fa48("2774") ? typeof record === "object" : stryMutAct_9fa48("2773") ? false : (stryCov_9fa48("2773", "2774"), typeof record !== (stryMutAct_9fa48("2775") ? "" : (stryCov_9fa48("2775"), "object")))))) || (stryMutAct_9fa48("2777") ? typeof record.nonce === "string" : stryMutAct_9fa48("2776") ? false : (stryCov_9fa48("2776", "2777"), typeof record.nonce !== (stryMutAct_9fa48("2778") ? "" : (stryCov_9fa48("2778"), "string")))))) || (stryMutAct_9fa48("2780") ? typeof record.digest === "string" : stryMutAct_9fa48("2779") ? false : (stryCov_9fa48("2779", "2780"), typeof record.digest !== (stryMutAct_9fa48("2781") ? "" : (stryCov_9fa48("2781"), "string")))))) || transaction.consumedRecords.has(record.nonce))) throw corrupt();
          new Digest(record.digest);
          transaction.consumedRecords.set(record.nonce, record.digest);
        }
      }
      for (const nonce of transaction.issuedRecords.keys()) {
        if (stryMutAct_9fa48("2782")) {
          {}
        } else {
          stryCov_9fa48("2782");
          if (stryMutAct_9fa48("2784") ? false : stryMutAct_9fa48("2783") ? true : (stryCov_9fa48("2783", "2784"), transaction.consumedRecords.has(nonce))) throw corrupt();
        }
      }
      this.#issued = transaction.issuedRecords;
      this.#consumed = transaction.consumedRecords;
    }
  }
  private requireTransaction(transaction: MemoryAuthorityPermitTransaction): void {
    if (stryMutAct_9fa48("2785")) {
      {}
    } else {
      stryCov_9fa48("2785");
      if (stryMutAct_9fa48("2788") ? !(transaction instanceof MemoryAuthorityPermitTransaction) && transaction.ownerToken !== this.#ownerToken : stryMutAct_9fa48("2787") ? false : stryMutAct_9fa48("2786") ? true : (stryCov_9fa48("2786", "2787", "2788"), (stryMutAct_9fa48("2789") ? transaction instanceof MemoryAuthorityPermitTransaction : (stryCov_9fa48("2789"), !(transaction instanceof MemoryAuthorityPermitTransaction))) || (stryMutAct_9fa48("2791") ? transaction.ownerToken === this.#ownerToken : stryMutAct_9fa48("2790") ? false : (stryCov_9fa48("2790", "2791"), transaction.ownerToken !== this.#ownerToken)))) throw new TypeError(stryMutAct_9fa48("2792") ? "" : (stryCov_9fa48("2792"), "Authority permit transaction belongs to another owner store"));
    }
  }
  private requireUnused(transaction: MemoryAuthorityPermitTransaction, nonce: string): void {
    if (stryMutAct_9fa48("2793")) {
      {}
    } else {
      stryCov_9fa48("2793");
      if (stryMutAct_9fa48("2796") ? transaction.issuedRecords.has(nonce) && transaction.consumedRecords.has(nonce) : stryMutAct_9fa48("2795") ? false : stryMutAct_9fa48("2794") ? true : (stryCov_9fa48("2794", "2795", "2796"), transaction.issuedRecords.has(nonce) || transaction.consumedRecords.has(nonce))) throw denied(stryMutAct_9fa48("2797") ? "" : (stryCov_9fa48("2797"), "Authority permit nonce was already used by this Actor owner"));
    }
  }
  private assertIssuedOwner(permit: AuthorityPermit): void {
    if (stryMutAct_9fa48("2798")) {
      {}
    } else {
      stryCov_9fa48("2798");
      if (stryMutAct_9fa48("2801") ? false : stryMutAct_9fa48("2800") ? true : stryMutAct_9fa48("2799") ? permit.issuer.equals(this.owner) : (stryCov_9fa48("2799", "2800", "2801"), !permit.issuer.equals(this.owner))) {
        if (stryMutAct_9fa48("2802")) {
          {}
        } else {
          stryCov_9fa48("2802");
          throw denied(stryMutAct_9fa48("2803") ? "" : (stryCov_9fa48("2803"), "Authority permit was issued by another Actor owner"));
        }
      }
    }
  }
}
function cloneBytesMap(source: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array> {
  if (stryMutAct_9fa48("2804")) {
    {}
  } else {
    stryCov_9fa48("2804");
    return new Map((stryMutAct_9fa48("2805") ? [] : (stryCov_9fa48("2805"), [...source])).map(stryMutAct_9fa48("2806") ? () => undefined : (stryCov_9fa48("2806"), ([key, bytes]) => stryMutAct_9fa48("2807") ? [] : (stryCov_9fa48("2807"), [key, stryMutAct_9fa48("2808") ? bytes : (stryCov_9fa48("2808"), bytes.slice())]))));
  }
}
function denied(message: string): AgentCoreError {
  if (stryMutAct_9fa48("2809")) {
    {}
  } else {
    stryCov_9fa48("2809");
    return new AgentCoreError(stryMutAct_9fa48("2810") ? "" : (stryCov_9fa48("2810"), "authority.denied"), message);
  }
}
function corrupt(): AgentCoreError {
  if (stryMutAct_9fa48("2811")) {
    {}
  } else {
    stryCov_9fa48("2811");
    return new AgentCoreError(stryMutAct_9fa48("2812") ? "" : (stryCov_9fa48("2812"), "codec.invalid"), stryMutAct_9fa48("2813") ? "" : (stryCov_9fa48("2813"), "Stored authority permit ownership is malformed"));
  }
}