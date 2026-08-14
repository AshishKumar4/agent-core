import { RecordCodec, Revision, SecretRef, type JsonValue } from "../core";
import { AgentCoreError } from "../errors";
import { BindingName, FacetRef, ProtectionDomain } from "../facets";
import { requireSubjectTenant, type ScopeRef, type SubjectRef } from "../identity";
import {
    requireExact,
    requireArray,
    requireObject,
    requireSafeInteger,
    requireString,
    type JsonObject
} from "./data";
import { GrantId } from "./id";
import {
    decodeAuthorityScope,
    decodeAuthoritySubject,
    encodeAuthorityScope,
    encodeAuthoritySubject,
    scopeKey,
    subjectKey
} from "./reference";
import { authorityKey } from "./key";

export type BindingStateName = "active" | "inactive";

export class BindingCredentialCustody {
    public readonly secret: SecretRef;
    public readonly endpoint: string;

    public constructor(secret: SecretRef, endpoint: string) {
        if (secret.constructor !== SecretRef) {
            throw new TypeError("Binding credential custody requires an exact SecretRef");
        }
        this.secret = new SecretRef(secret.source, secret.provider, secret.id);
        this.endpoint = requireCanonicalEndpoint(endpoint);
        Object.freeze(this);
    }

    public matches(secret: SecretRef, endpoint: string): boolean {
        return this.secret.equals(secret) && this.endpoint === endpoint;
    }

    public toData(): JsonObject {
        return {
            endpoint: this.endpoint,
            secret: {
                id: this.secret.id,
                provider: this.secret.provider,
                source: this.secret.source
            }
        };
    }

    public static fromData(value: JsonValue | undefined): BindingCredentialCustody {
        const object = requireObject(value, "Binding credential custody");
        requireExact(object, ["endpoint", "secret"], "Binding credential custody");
        const secret = requireObject(object["secret"], "Binding credential SecretRef");
        requireExact(secret, ["id", "provider", "source"], "Binding credential SecretRef");
        return new BindingCredentialCustody(
            new SecretRef(
                requireString(secret, "source", "SecretRef source"),
                requireString(secret, "provider", "SecretRef provider"),
                requireString(secret, "id", "SecretRef ID")
            ),
            requireString(object, "endpoint", "Binding credential endpoint")
        );
    }
}

abstract class BindingLifecycle {
    public abstract readonly name: BindingStateName;
    public abstract activate(): BindingLifecycle;
    public abstract deactivate(): BindingLifecycle;

    public static from(state: BindingStateName): BindingLifecycle {
        return state === "active" ? activeBinding : inactiveBinding;
    }
}

class ActiveBindingLifecycle extends BindingLifecycle {
    public readonly name = "active" as const;
    public activate(): BindingLifecycle {
        return this;
    }
    public deactivate(): BindingLifecycle {
        return inactiveBinding;
    }
}

class InactiveBindingLifecycle extends BindingLifecycle {
    public readonly name = "inactive" as const;
    public activate(): BindingLifecycle {
        return activeBinding;
    }
    public deactivate(): BindingLifecycle {
        return this;
    }
}

const activeBinding = Object.freeze(new ActiveBindingLifecycle());
const inactiveBinding = Object.freeze(new InactiveBindingLifecycle());

class BindingCodec extends RecordCodec<Binding> {
    public constructor() {
        super("authority.binding", { major: 3, minor: 0 });
    }
    protected encodePayload(record: Binding): JsonValue {
        return record.toData();
    }
    protected decodePayload(payload: JsonValue): Binding {
        return Binding.fromData(payload);
    }
}

export class Binding {
    public static readonly codec: RecordCodec<Binding> = new BindingCodec();
    public readonly domain: ProtectionDomain;
    public readonly subject: SubjectRef;
    public readonly credentialCustody: readonly BindingCredentialCustody[];
    readonly #lifecycle: BindingLifecycle;

    public constructor(
        public readonly scope: ScopeRef,
        subject: SubjectRef,
        domain: ProtectionDomain,
        public readonly name: BindingName,
        public readonly grantId: GrantId,
        public readonly facet: FacetRef,
        public readonly generation: number,
        state: BindingStateName,
        public readonly revision: Revision,
        credentialCustody: readonly BindingCredentialCustody[] = []
    ) {
        if (scope.kind !== "workspace") {
            throw new TypeError("Bindings require a Workspace Scope");
        }
        if (!Number.isSafeInteger(generation) || generation < 0) {
            throw new TypeError("Binding generation must be a non-negative safe integer");
        }
        this.#lifecycle = BindingLifecycle.from(requireBindingState(state));
        requireSubjectTenant(subject, scope.tenantId, "Binding");
        this.subject = decodeAuthoritySubject(encodeAuthoritySubject(subject));
        this.domain = immutableDomain(domain);
        this.credentialCustody = canonicalCredentialCustody(credentialCustody, scope);
        Object.freeze(this);
    }

    public static active(
        scope: ScopeRef,
        subject: SubjectRef,
        domain: ProtectionDomain,
        name: BindingName,
        grantId: GrantId,
        facet: FacetRef,
        credentialCustody: readonly BindingCredentialCustody[] = []
    ): Binding {
        return new Binding(
            scope,
            subject,
            domain,
            name,
            grantId,
            facet,
            0,
            "active",
            Revision.initial(),
            credentialCustody
        );
    }

    public static encode(record: Binding): Uint8Array {
        return Binding.codec.encode(record);
    }
    public static decode(bytes: Uint8Array): Binding {
        return Binding.codec.decode(bytes);
    }

    /**
     * Binding identity is exactly its addressing coordinates, so a caller holding those
     * can look one up without first fabricating a record around a Grant and Facet it
     * does not yet know.
     */
    public static keyFor(
        scope: ScopeRef,
        subject: SubjectRef,
        domain: ProtectionDomain,
        name: BindingName
    ): string {
        return authorityKey("binding", [
            encodeAuthorityScope(scope),
            encodeAuthoritySubject(subject),
            encodeDomain(domain),
            name.value
        ]);
    }

    public get key(): string {
        return Binding.keyFor(this.scope, this.subject, this.domain, this.name);
    }

    public get resolves(): boolean {
        return this.state === "active";
    }
    public get state(): BindingStateName {
        return this.#lifecycle.name;
    }

    public replace(
        grantId: GrantId,
        facet: FacetRef,
        credentialCustody: readonly BindingCredentialCustody[] = this.credentialCustody
    ): Binding {
        return this.transition(this.#lifecycle.activate(), grantId, facet, credentialCustody);
    }

    public deactivate(): Binding {
        const next = this.#lifecycle.deactivate();
        return next === this.#lifecycle
            ? this
            : this.transition(next, this.grantId, this.facet, this.credentialCustody);
    }

    public hasCredentialCustody(secret: SecretRef, endpoint: string): boolean {
        return this.credentialCustody.some((custody) => custody.matches(secret, endpoint));
    }

    public assertCanReplace(next: Binding): void {
        if (
            this.key !== next.key ||
            scopeKey(this.scope) !== scopeKey(next.scope) ||
            subjectKey(this.subject) !== subjectKey(next.subject) ||
            next.generation !== this.generation + 1 ||
            next.revision.value !== this.revision.value + 1
        ) {
            throw new AgentCoreError(
                "binding.invalid",
                "Binding updates require immutable identity and the next generation and revision"
            );
        }
    }

    public toData(): JsonObject {
        return {
            credentialCustody: this.credentialCustody.map((custody) => custody.toData()),
            domain: encodeDomain(this.domain),
            facet: this.facet.value,
            generation: this.generation,
            grantId: this.grantId.value,
            name: this.name.value,
            revision: this.revision.value,
            scope: encodeAuthorityScope(this.scope),
            state: this.state,
            subject: encodeAuthoritySubject(this.subject)
        };
    }

    public static fromData(value: JsonValue | undefined): Binding {
        const object = requireObject(value, "Binding");
        requireExact(
            object,
            [
                "domain",
                "credentialCustody",
                "facet",
                "generation",
                "grantId",
                "name",
                "revision",
                "scope",
                "state",
                "subject"
            ],
            "Binding"
        );
        return new Binding(
            decodeAuthorityScope(object["scope"]),
            decodeAuthoritySubject(object["subject"]),
            decodeDomain(object["domain"]),
            new BindingName(requireString(object, "name", "Binding name")),
            new GrantId(requireString(object, "grantId", "Grant ID")),
            new FacetRef(requireString(object, "facet", "Facet reference")),
            requireSafeInteger(object, "generation", "Binding generation"),
            requireBindingState(object["state"]),
            new Revision(requireSafeInteger(object, "revision", "Binding revision")),
            requireArray(object["credentialCustody"], "Binding credential custody").map(
                BindingCredentialCustody.fromData
            )
        );
    }

    private transition(
        state: BindingLifecycle,
        grantId: GrantId,
        facet: FacetRef,
        credentialCustody: readonly BindingCredentialCustody[]
    ): Binding {
        if (
            this.generation === Number.MAX_SAFE_INTEGER ||
            this.revision.value === Number.MAX_SAFE_INTEGER
        ) {
            throw new AgentCoreError("binding.invalid", "Binding generation is exhausted");
        }
        return new Binding(
            this.scope,
            this.subject,
            this.domain,
            this.name,
            grantId,
            facet,
            this.generation + 1,
            state.name,
            this.revision.next(),
            credentialCustody
        );
    }
}

function canonicalCredentialCustody(
    values: readonly BindingCredentialCustody[],
    scope: ScopeRef
): readonly BindingCredentialCustody[] {
    const canonical = values.map((value) => {
        if (value.constructor !== BindingCredentialCustody) {
            throw new TypeError(
                "Binding credential custody requires exact BindingCredentialCustody values"
            );
        }
        if (value.secret.source !== scope.tenantId.value) {
            throw new TypeError("Binding credential source must equal its canonical Tenant ID");
        }
        return new BindingCredentialCustody(value.secret, value.endpoint);
    });
    canonical.sort(compareCredentialCustody);
    let previous: BindingCredentialCustody | undefined;
    for (const value of canonical) {
        if (previous !== undefined && compareCredentialCustody(previous, value) === 0) {
            throw new TypeError("Binding credential custody facts must be unique");
        }
        previous = value;
    }
    return Object.freeze(canonical);
}

function compareCredentialCustody(
    left: BindingCredentialCustody,
    right: BindingCredentialCustody
): number {
    for (const [leftPart, rightPart] of [
        [left.secret.source, right.secret.source],
        [left.secret.provider, right.secret.provider],
        [left.secret.id, right.secret.id],
        [left.endpoint, right.endpoint]
    ] as const) {
        if (leftPart < rightPart) return -1;
        if (leftPart > rightPart) return 1;
    }
    return 0;
}

function requireCanonicalEndpoint(value: string): string {
    let endpoint: URL;
    try {
        endpoint = new URL(value);
    } catch {
        throw new TypeError("Binding credential endpoint must be a canonical absolute URL");
    }
    if (endpoint.href !== value || endpoint.username.length > 0 || endpoint.password.length > 0) {
        throw new TypeError("Binding credential endpoint must be a canonical absolute URL");
    }
    return value;
}

export function encodeDomain(domain: ProtectionDomain): JsonObject {
    return { kind: domain.kind, label: domain.label, secretPolicy: domain.secretPolicy };
}

export function domainKey(domain: ProtectionDomain): string {
    return authorityKey("domain", [encodeDomain(domain)]);
}

function immutableDomain(domain: ProtectionDomain): ProtectionDomain {
    return Object.freeze(new ProtectionDomain(domain.kind, domain.label, domain.secretPolicy));
}

export function decodeDomain(value: JsonValue | undefined): ProtectionDomain {
    const object = requireObject(value, "Protection domain");
    requireExact(object, ["kind", "label", "secretPolicy"], "Protection domain");
    const kind = object["kind"];
    const secretPolicy = object["secretPolicy"];
    if (kind !== "frontend" && kind !== "backend") {
        throw new TypeError("Protection domain kind is invalid");
    }
    if (secretPolicy !== "no-secrets" && secretPolicy !== "may-hold-secrets") {
        throw new TypeError("Protection domain secret policy is invalid");
    }
    return new ProtectionDomain(
        kind,
        requireString(object, "label", "Protection domain label"),
        secretPolicy
    );
}

function requireBindingState(value: JsonValue | undefined): BindingStateName {
    if (value === "active" || value === "inactive") return value;
    throw new TypeError("Binding state is invalid");
}
