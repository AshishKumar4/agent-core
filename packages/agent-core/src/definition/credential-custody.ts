import { SecretRef, hasExactJsonKeys, isJsonObject, type JsonValue } from "../core";
import type { ManagedStateRecord } from "./generation";
import { invalidDefinition } from "./error";

/**
 * §3.5 SecretRef custody. A SecretRef resolves only inside the Tenant its `source` names
 * and only for the exact consumer and target endpoint that Tenant recorded, so the
 * `(SecretRef, consumer, endpoint)` triple is the custody record and a resolution seam
 * checks the presented triple against it before any value is produced.
 *
 * The seam takes custody as data rather than a `Binding`, for two independent reasons.
 * §3.5 leaves the consumer set open — "a Binding, an Environment, an ingress
 * declaration's `verification.secret`, or any other consumer this document or a profile
 * names" — so a Binding-typed parameter would leave the rule unstatable for every other
 * consumer kind. And the authority context already imports this one, so a Binding-typed
 * parameter would close a runtime context cycle.
 */
const CANONICAL_KIND = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;

/**
 * A consumer's identity is its kind paired with its own canonical key, never a bare
 * string: a Binding and an Environment may carry the same name, and an identity that
 * could not tell them apart would make custody recorded for one presentable by the
 * other, widening the recorded-consumer set §3.5 pins the blast radius to. The kind is
 * data rather than a closed union because §3.5 leaves the consumer set open to profiles;
 * identity is the pair either way, so no profile's consumer can collide with a core one.
 */
export class CredentialConsumerRef {
    public readonly kind: string;
    public readonly id: string;

    public constructor(kind: string, id: string) {
        if (!CANONICAL_KIND.test(kind)) {
            throw new TypeError("Credential consumer kind must be a canonical identifier");
        }
        if (id.length === 0 || id !== id.trim()) {
            throw new TypeError("Credential consumer ID must be a nonblank canonical string");
        }
        this.kind = kind;
        this.id = id;
        Object.freeze(this);
    }

    public equals(other: CredentialConsumerRef): boolean {
        return (
            other.constructor === CredentialConsumerRef &&
            this.kind === other.kind &&
            this.id === other.id
        );
    }
}

/**
 * One custody fact a Tenant-owned consumer's own record carries: the SecretRef the
 * Tenant accepted and the exact target endpoint it authorized it for.
 */
export class CredentialCustodyFact {
    public readonly secret: SecretRef;
    public readonly endpoint: string;

    public constructor(secret: SecretRef, endpoint: string) {
        if (secret.constructor !== SecretRef) {
            throw new TypeError("A credential custody fact requires an exact SecretRef");
        }
        this.secret = new SecretRef(secret.source, secret.provider, secret.id);
        this.endpoint = requireExactEndpoint(endpoint);
        Object.freeze(this);
    }

    /**
     * The form a consumer's own durable record carries the fact in. It is exactly the
     * pairing §3.5 names — one SecretRef and one target endpoint — so a Binding's stored
     * custody and a Blueprint-declared Environment's are the same fact written down twice
     * rather than two custody vocabularies.
     */
    public static fromData(value: JsonValue | undefined, subject: string): CredentialCustodyFact {
        const object = requireCustodyObject(value, subject);
        if (!hasExactJsonKeys(object, ["endpoint", "secret"])) {
            throw invalidDefinition(`${subject} contains missing or unknown fields`);
        }
        const secret = requireCustodyObject(object["secret"], `${subject} SecretRef`);
        if (!hasExactJsonKeys(secret, ["id", "provider", "source"])) {
            throw invalidDefinition(`${subject} SecretRef contains missing or unknown fields`);
        }
        return new CredentialCustodyFact(
            new SecretRef(
                requireCustodyText(secret["source"], `${subject} SecretRef source`),
                requireCustodyText(secret["provider"], `${subject} SecretRef provider`),
                requireCustodyText(secret["id"], `${subject} SecretRef ID`)
            ),
            requireCustodyText(object["endpoint"], `${subject} endpoint`)
        );
    }

    public get key(): string {
        return [this.secret.source, this.secret.provider, this.secret.id, this.endpoint].join(
            "\u0000"
        );
    }
}

/**
 * The custody one Tenant-owned consumer holds, projected from that consumer's own
 * record. §3.5 fixes that custody is a fact a consumer's record carries and not a new
 * durable record kind, so this is a read-time projection and never a store: the durable
 * home stays the consumer's record under §8.4's one-owner rule.
 */
export class CredentialCustody {
    public readonly tenant: string;
    public readonly consumer: CredentialConsumerRef;
    public readonly resolves: boolean;
    public readonly facts: readonly CredentialCustodyFact[];

    public constructor(
        tenant: string,
        consumer: CredentialConsumerRef,
        resolves: boolean,
        facts: readonly CredentialCustodyFact[]
    ) {
        if (tenant.length === 0 || tenant !== tenant.trim()) {
            throw new TypeError("Credential custody requires a canonical Tenant ID");
        }
        if (consumer.constructor !== CredentialConsumerRef) {
            throw new TypeError("Credential custody requires an exact consumer reference");
        }
        this.tenant = tenant;
        this.consumer = consumer;
        this.resolves = resolves;
        this.facts = Object.freeze(
            facts.map((fact) => {
                if (fact.constructor !== CredentialCustodyFact) {
                    throw new TypeError("Credential custody requires exact custody facts");
                }
                // §3.5: `source` MUST equal the exact canonical value of that Tenant's
                // TenantId, checked by whatever records custody.
                if (fact.secret.source !== tenant) {
                    throw new TypeError(
                        "A credential custody fact's SecretRef source must equal its Tenant ID"
                    );
                }
                return fact;
            })
        );
        Object.freeze(this);
    }
}

/**
 * The triple a resolution presents. There is no Principal, Membership or presenter
 * component and none can be added by a caller: §3.5's resolution scope is Tenant-scoped
 * and Principal-independent, so a seam that could be handed an asker would make a
 * SecretRef a name whose meaning depends on who asks.
 */
export class CredentialResolutionRequest {
    public readonly secret: SecretRef;
    public readonly consumer: CredentialConsumerRef;
    public readonly endpoint: string;

    public constructor(secret: SecretRef, consumer: CredentialConsumerRef, endpoint: string) {
        if (secret.constructor !== SecretRef) {
            throw new TypeError("A credential resolution requires an exact SecretRef");
        }
        if (consumer.constructor !== CredentialConsumerRef) {
            throw new TypeError("A credential resolution requires an exact consumer reference");
        }
        this.secret = new SecretRef(secret.source, secret.provider, secret.id);
        this.consumer = consumer;
        this.endpoint = requireExactEndpoint(endpoint);
        Object.freeze(this);
    }
}

/**
 * Why custody refused. Every reason is a fact the Tenant's own record answers, which is
 * what makes a refusal confirmed rather than merely unsuccessful.
 */
export type CredentialRefusalReason =
    /** The triple names a consumer other than the one holding this custody. */
    | "consumer-unrecorded"
    /** `secret.source` is not this custody's Tenant — a cross-Tenant presentation. */
    | "foreign-tenant"
    /** The recorded consumer no longer resolves; its custody is revoked with it. */
    | "consumer-revoked"
    /** This consumer records no custody for that SecretRef at all. */
    | "secret-unrecorded"
    /** Custody exists for that SecretRef but names a different target endpoint. */
    | "endpoint-unrecorded";

export type CredentialResolutionOutcome = "presented" | "refused" | "indeterminate";

/**
 * A resolution's outcome. Three shapes for three questions, because a custody refusal
 * and a provider that does not answer are different facts with different consequences:
 * §3.5 makes a confirmed custody refusal an ordinary failed attempt, while a provider
 * outcome the seam does not hold settles nothing and stays indeterminate. A single
 * absent-value result would answer both with one representation.
 *
 * `presented` carries nothing by construction: the credential went into transport and
 * never to the caller, which is the isolation §3.5 asks substrates for.
 */
export abstract class CredentialResolution {
    public static get presented(): CredentialResolution {
        return presentedResolution;
    }

    /** The provider's own answer, which the seam either holds or does not. */
    public static get indeterminate(): CredentialResolution {
        return indeterminateResolution;
    }

    public static refused(reason: CredentialRefusalReason): CredentialResolution {
        return new RefusedResolution(reason);
    }

    public abstract readonly outcome: CredentialResolutionOutcome;
    public abstract readonly refusal: CredentialRefusalReason | undefined;
}

class PresentedResolution extends CredentialResolution {
    public readonly outcome = "presented" as const;
    public readonly refusal = undefined;
}

class IndeterminateResolution extends CredentialResolution {
    public readonly outcome = "indeterminate" as const;
    public readonly refusal = undefined;
}

class RefusedResolution extends CredentialResolution {
    public readonly outcome = "refused" as const;

    public constructor(public readonly refusal: CredentialRefusalReason) {
        super();
        Object.freeze(this);
    }
}

const presentedResolution: CredentialResolution = Object.freeze(new PresentedResolution());
const indeterminateResolution: CredentialResolution = Object.freeze(new IndeterminateResolution());

/**
 * Where raw credential material goes. §3.5 requires that a ref-only configuration not be
 * undone by plaintext an agent can read, so a provider writes the value here — a
 * proxy-injected header, a masked environment variable (§4.5) — and no seam ever returns
 * it.
 */
export interface CredentialTransport {
    injectCredential(field: string, value: string): void;
}

/**
 * Holds raw credential material for the Tenant. A provider is asked only after custody
 * has already authorized the exact fact, and it reports whether it holds the credential
 * rather than whether the resolution is allowed: the refusal decision stays with the
 * Tenant's record, so no provider can claim a Tenant refused.
 */
export abstract class CredentialProvider {
    public abstract present(fact: CredentialCustodyFact, transport: CredentialTransport): boolean;
}

/**
 * The §4.5 credential-isolation seam §3.5 names. The signature is the rule: the decision
 * is a function of the presented triple and the custody record alone.
 */
export abstract class CredentialIsolationSeam {
    public abstract resolve(
        request: CredentialResolutionRequest,
        transport: CredentialTransport
    ): CredentialResolution;
}

/**
 * The in-memory reference seam, deciding from one consumer's recorded custody.
 */
export class RecordedCustodySeam extends CredentialIsolationSeam {
    public constructor(
        private readonly custody: CredentialCustody,
        private readonly provider: CredentialProvider
    ) {
        super();
        Object.freeze(this);
    }

    public resolve(
        request: CredentialResolutionRequest,
        transport: CredentialTransport
    ): CredentialResolution {
        // An inexact request is refused rather than read: a subtype carrying a presenting
        // Principal would otherwise be honored as a narrower scope, which §3.5 forbids
        // for a custody fact and equally for the key presented against one.
        if (request.constructor !== CredentialResolutionRequest) {
            throw invalidDefinition("A credential resolution requires an exact request triple");
        }
        if (!this.custody.consumer.equals(request.consumer)) {
            return CredentialResolution.refused("consumer-unrecorded");
        }
        // Re-checked at read time rather than trusted from the record, so a custody fact
        // written before this rule existed cannot resolve outside its Tenant.
        if (request.secret.source !== this.custody.tenant) {
            return CredentialResolution.refused("foreign-tenant");
        }
        if (!this.custody.resolves) {
            return CredentialResolution.refused("consumer-revoked");
        }
        const recorded = this.custody.facts.filter((fact) => fact.secret.equals(request.secret));
        if (recorded.length === 0) {
            return CredentialResolution.refused("secret-unrecorded");
        }
        // Repointing an integration at a new endpoint invalidates the old resolution
        // rather than presenting the old credential to the new place, so a ref still in
        // custody at another endpoint is a distinct answer from one never accepted.
        const fact = recorded.find((candidate) => candidate.endpoint === request.endpoint);
        if (fact === undefined) {
            return CredentialResolution.refused("endpoint-unrecorded");
        }
        return this.provider.present(fact, transport)
            ? CredentialResolution.presented
            : CredentialResolution.indeterminate;
    }
}

/**
 * §3.5 names an Environment among the consumers that accept a SecretRef, and §9.2 is where
 * a Tenant declares one: a Blueprint's `environments` entry is materialized (§9.3) into the
 * Blueprint-managed `environment` record this projects from. The custody stays that
 * record's own constituent data — a `credentials` list of (SecretRef, endpoint) pairs — so
 * the seam gains a second consumer kind to check without a store or a record kind of its
 * own. `resolves` is the consumer's own liveness: a declaration the active generation no
 * longer carries stops resolving with the record that held it.
 */
export function environmentCredentialCustody(
    record: ManagedStateRecord,
    resolves: boolean
): CredentialCustody {
    if (record.recordKind !== ENVIRONMENT_RECORD_KIND) {
        throw invalidDefinition("Environment custody reads an Environment declaration record");
    }
    return new CredentialCustody(
        record.origin.tenantId.value,
        new CredentialConsumerRef(ENVIRONMENT_RECORD_KIND, record.logicalKey),
        resolves,
        declaredCustodyFacts(record.desired, "Environment credential custody")
    );
}

/**
 * §3.5: the Tenant scope of a custody record is checked by whatever records it, so a
 * declaration that names another Tenant's SecretRef is refused as it is written rather
 * than resolving later against a Tenant that never accepted it.
 */
export function requireRecordedCustody(record: ManagedStateRecord): void {
    if (record.recordKind !== ENVIRONMENT_RECORD_KIND) return;
    environmentCredentialCustody(record, true);
}

/**
 * The declared custody a Blueprint-managed record carries, refused as a set rather than a
 * list: one (SecretRef, endpoint) pair written twice is an inexact custody value, and §3.5
 * makes exactness the rule wherever custody is written.
 */
export function declaredCustodyFacts(
    desired: JsonValue,
    subject: string
): readonly CredentialCustodyFact[] {
    const declaration = requireCustodyObject(desired, subject);
    const declared = declaration[CUSTODY_DECLARATION_FIELD];
    if (declared === undefined) return [];
    if (!Array.isArray(declared) || declared.length === 0) {
        throw invalidDefinition(`${subject} must be a nonempty list when it is declared`);
    }
    const facts = declared.map((value) => CredentialCustodyFact.fromData(value, subject));
    const keys = new Set<string>();
    for (const fact of facts) {
        if (keys.has(fact.key)) {
            throw invalidDefinition(`${subject} repeats one SecretRef and endpoint pair`);
        }
        keys.add(fact.key);
    }
    return Object.freeze(facts);
}

/**
 * A target endpoint is compared, never interpreted. §3.5 makes exactness the rule and
 * leaves the endpoint's form to whoever records custody — a Binding already requires a
 * canonical absolute URL, and an Environment's injection target need not be one at all —
 * so restating that policy here would be a second copy of a rule this seam does not own.
 * Comparing tokens is also fail-closed: two spellings of one endpoint refuse rather than
 * resolve.
 */
function requireExactEndpoint(value: string): string {
    if (value.length === 0 || value !== value.trim()) {
        throw new TypeError("A credential target endpoint must be a nonblank exact token");
    }
    return value;
}

/**
 * The one Blueprint-managed record kind that carries custody today (§9.2's `environments`),
 * and the field it carries it in. A profile that names another consumer records its own
 * custody on its own record; §3.5 keeps the consumer set open and the fact shape fixed.
 */
const ENVIRONMENT_RECORD_KIND = "environment";
const CUSTODY_DECLARATION_FIELD = "credentials";

function requireCustodyObject(
    value: JsonValue | undefined,
    subject: string
): { readonly [key: string]: JsonValue } {
    if (!isJsonObject(value)) throw invalidDefinition(`${subject} must be an object`);
    return value;
}

function requireCustodyText(value: JsonValue | undefined, subject: string): string {
    if (!isCustodyText(value) || value.length === 0 || value !== value.trim()) {
        throw invalidDefinition(`${subject} must be a nonblank canonical string`);
    }
    return value;
}

function isCustodyText(value: JsonValue | undefined): value is string {
    return typeof value === "string";
}
